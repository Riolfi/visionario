import type { APIRoute } from 'astro';
import { cancelCaixaSale, getOrderByNumber, recordCancellation } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { CANCEL_REASONS_CAIXA, CANCEL_REASONS_ONLINE, cancelOnlineOrder, joinReason } from '../../../../lib/order-policy';

/**
 * POST /api/admin/orders/cancel — order_number, motivo (da lista do canal;
 * "Outro" pede detalhe). Regra pedidos.cancelar.
 *  - Caixa: devolve os itens ao estoque; o valor sai do caixa do dia.
 *  - Online: antes do envio; estorna no Mercado Pago (falhou = nada muda),
 *    devolve ao estoque e avisa o cliente com o reembolso.
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

  if (order.source === 'caixa') {
    try {
      await cancelCaixaSale(number);
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Não foi possível cancelar a compra.');
    }
    await recordCancellation(number, by, reason);
    setFlash(cookies, 'ok', 'Venda cancelada. Os itens voltaram ao estoque e o valor saiu do caixa de hoje — devolva ao cliente no balcão.');
    return redirect(back);
  }

  const r = await cancelOnlineOrder(order, by, reason);
  if (!r.ok) return fail(r.error);
  const refund = r.refundedCents
    ? r.simulated
      ? ' (pagamento de teste: nada a estornar)'
      : ' O valor foi estornado ao cliente pelo Mercado Pago.'
    : '';
  setFlash(cookies, 'ok', `Compra cancelada. Os itens voltaram ao estoque e o cliente foi avisado por e-mail.${refund}`);
  return redirect(back);
};
