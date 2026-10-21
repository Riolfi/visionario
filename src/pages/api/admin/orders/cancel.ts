import type { APIRoute } from 'astro';
import { cancelCaixaSale, getOrderByNumber, recordCancellation } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { CANCEL_REASONS_CAIXA, CANCEL_REASONS_ONLINE, caixaRefundPlan, cancelOnlineOrder, joinReason, manualRefundText, refundCaixaPix, withdrawStock } from '../../../../lib/order-policy';
import { brl } from '../../../../lib/format';
import { isValidEmail } from '../../../../lib/format';
import { RECEIVED_STATUSES } from '../../../../lib/types';

/**
 * POST /api/admin/orders/cancel — order_number, motivo (da lista do canal;
 * "Outro" pede detalhe). Regra pedidos.cancelar.
 *  - Caixa: devolve os itens ao estoque; o valor sai do caixa do dia.
 *  - Online: antes do envio; estorna no Mercado Pago (falhou = nada muda),
 *    devolve ao estoque e avisa o cliente com o reembolso.
 * restock=on devolve os itens ao estoque (desmarcado: produto danificado);
 * notify=on avisa o cliente (e-mail inválido com aviso marcado = não cancela).
 * Grava quem cancelou, quando e o motivo.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  const fail = (msg: string) => {
    setFlash(cookies, 'erro', msg);
    return redirect(back);
  };
  // o middleware já confere; de novo aqui porque é ação destrutiva
  if (!can(locals.admin, 'pedidos.cancelar')) return fail('Seu cargo não permite cancelar vendas.');
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  if (order.status === 'cancelled') return fail('Esta venda já está cancelada.');

  const motivo = String(form.get('motivo') || '').trim();
  const reasons = order.source === 'caixa' ? CANCEL_REASONS_CAIXA : CANCEL_REASONS_ONLINE;
  if (!reasons.includes(motivo)) return fail('Escolha o motivo do cancelamento.');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return fail('Informe o motivo do cancelamento.');
  const by = locals.user?.id ?? null;
  const restock = form.get('restock') === 'on';
  const notify = form.get('notify') === 'on';

  if (order.source === 'caixa') {
    // Pix do Caixa: o Mercado Pago estorna antes (falhou = nada muda); dinheiro e maquininha, à mão
    const plan = caixaRefundPlan(order);
    const refund = order.status === 'paid' ? await refundCaixaPix(order) : { ok: true as const, refundedCents: 0 };
    if (!refund.ok) return fail(refund.error);
    try {
      await cancelCaixaSale(number);
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Não foi possível cancelar a venda.');
    }
    if (!restock) await withdrawStock(order.items);
    await recordCancellation(number, by, reason);
    const pixNote = refund.refundedCents ? ` ${brl(refund.refundedCents)} em Pix foram estornados ao cliente pelo Mercado Pago.` : '';
    const manualNote = plan.manual.length ? ` Devolva ao cliente ${manualRefundText(plan.manual)}.` : '';
    setFlash(cookies, 'ok', `Venda cancelada. ${restock ? 'Os itens voltaram ao estoque' : 'Os itens não voltaram ao estoque'} e o valor saiu do caixa do dia.${pixNote}${manualNote}`);
    return redirect(back);
  }

  // aviso marcado exige e-mail válido (desmarcado, cancela sem e-mail)
  if (notify && !isValidEmail(order.customer_email ?? '')) return fail('E-mail do cliente inválido: desmarque "Enviar e-mail ao cliente" para cancelar sem avisar.');
  const r = await cancelOnlineOrder(order, by, reason, { notify, restock });
  if (!r.ok) return fail(r.error);
  const refund = r.refundedCents
    ? r.simulated
      ? ' (pagamento de teste: nada a estornar)'
      : ' O valor foi estornado ao cliente pelo Mercado Pago.'
    : '';
  // só faz diferença se o estoque já tinha baixado (compra paga)
  const stock = RECEIVED_STATUSES.includes(order.status) ? (restock ? ' Os itens voltaram ao estoque.' : ' Os itens não voltaram ao estoque.') : '';
  setFlash(cookies, 'ok', `Venda cancelada.${stock}${notify ? ' O cliente foi avisado por e-mail.' : ''}${refund}`);
  return redirect(back);
};
