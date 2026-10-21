import type { APIRoute } from 'astro';
import { cancelCaixaSale, getOrderByNumber, recordCancellation } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import {
  CANCEL_REASONS_CAIXA,
  CANCEL_REASONS_ONLINE,
  applyStockDecision,
  caixaRefundPlan,
  cancelOnlineOrder,
  cancelRequestPending,
  joinReason,
  manualRefundText,
  refundCaixaPix,
  restockFromForm,
  stockWasOut,
  type StockDecision,
} from '../../../../lib/order-policy';
import { brl, isValidEmail } from '../../../../lib/format';

/**
 * POST /api/admin/orders/cancel — Janela de Confirmação de Cancelamento
 * (regra pedidos.cancelar). Campos: order_number, motivo/detalhe (no pedido
 * do cliente em análise, o motivo é o dele), stock_mode=now|later e
 * restock_<product_id>=unidades que voltam ao estoque (o resto vira perda),
 * notify=on (e-mail ao cliente, compra online).
 *  - Caixa: Pix estornado no Mercado Pago; dinheiro/maquininha à mão.
 *  - Online: antes do envio; estorna se pago (falhou = nada muda).
 * Grava quem validou, quando, o motivo e a decisão de estoque.
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

  // motivo: o do cliente (pedido em análise) ou um da lista do canal
  let reason: string;
  if (cancelRequestPending(order)) {
    reason = `Solicitação do cliente: ${order.cancel_request_reason ?? ''}`.slice(0, 500);
  } else {
    const motivo = String(form.get('motivo') || '').trim();
    const reasons = order.source === 'caixa' ? CANCEL_REASONS_CAIXA : CANCEL_REASONS_ONLINE;
    if (!reasons.includes(motivo)) return fail('Escolha o motivo do cancelamento.');
    reason = joinReason(motivo, String(form.get('detalhe') || ''));
    if (reason.length < 3) return fail('Informe o motivo do cancelamento.');
  }
  const by = locals.user?.id ?? null;
  const stock: StockDecision = form.get('stock_mode') === 'later' ? { mode: 'later' } : { mode: 'now', restock: restockFromForm(form) };
  const stockNote = !stockWasOut(order)
    ? ''
    : stock.mode === 'later'
      ? ' Os itens ficaram com estoque pendente: decida o que volta ao estoque quando forem devolvidos.'
      : ' O estoque foi atualizado conforme você definiu (o que não voltou ficou como perda).';

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
    if (stockWasOut(order)) await applyStockDecision(order, stock, by);
    await recordCancellation(number, by, reason);
    const pixNote = refund.refundedCents ? ` ${brl(refund.refundedCents)} em Pix foram estornados ao cliente pelo Mercado Pago.` : '';
    const manualNote = plan.manual.length ? ` Devolva ao cliente ${manualRefundText(plan.manual)}.` : '';
    setFlash(cookies, 'ok', `Venda cancelada e retirada do caixa do dia.${stockNote}${pixNote}${manualNote}`);
    return redirect(back);
  }

  // aviso marcado exige e-mail válido (desmarcado, cancela sem e-mail)
  const notify = form.get('notify') === 'on';
  if (notify && !isValidEmail(order.customer_email ?? '')) return fail('E-mail do cliente inválido: desmarque "Enviar e-mail ao cliente" para cancelar sem avisar.');
  const r = await cancelOnlineOrder(order, by, reason, { notify, stock });
  if (!r.ok) return fail(r.error);
  const refund = r.refundedCents
    ? r.simulated
      ? ' (pagamento de teste: nada a estornar)'
      : ' O valor foi estornado ao cliente pelo Mercado Pago.'
    : '';
  setFlash(cookies, 'ok', `Venda cancelada.${stockNote}${notify ? ' O cliente foi avisado por e-mail.' : ''}${refund}`);
  return redirect(back);
};
