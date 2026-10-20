import type { APIRoute } from 'astro';
import { cancelCaixaSale, getOrderByNumber, recordCancellation } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { CANCEL_REASONS_CAIXA, CANCEL_REASONS_ONLINE, cancelOnlineOrder, joinReason, withdrawStock } from '../../../../lib/order-policy';
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
  if (!can(locals.admin, 'pedidos.cancelar')) return fail('Seu cargo não permite cancelar compras.');
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  if (order.status === 'cancelled') return fail('Esta compra já está cancelada.');

  const motivo = String(form.get('motivo') || '').trim();
  const reasons = order.source === 'caixa' ? CANCEL_REASONS_CAIXA : CANCEL_REASONS_ONLINE;
  if (!reasons.includes(motivo)) return fail('Escolha o motivo do cancelamento.');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return fail('Informe o motivo do cancelamento.');
  const by = locals.user?.id ?? null;
  const restock = form.get('restock') === 'on';
  const notify = form.get('notify') === 'on';

  if (order.source === 'caixa') {
    try {
      await cancelCaixaSale(number);
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Não foi possível cancelar a compra.');
    }
    if (!restock) await withdrawStock(order.items);
    await recordCancellation(number, by, reason);
    setFlash(cookies, 'ok', `Venda cancelada. ${restock ? 'Os itens voltaram ao estoque' : 'Os itens não voltaram ao estoque'} e o valor saiu do caixa do dia — devolva ao cliente no balcão.`);
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
  setFlash(cookies, 'ok', `Compra cancelada.${stock}${notify ? ' O cliente foi avisado por e-mail.' : ''}${refund}`);
  return redirect(back);
};
