import type { APIRoute } from 'astro';
import { cancelCaixaSale, changeOrderStatus, getOrderByNumber, recordCancellation } from '../../../../lib/repo/orders';
import { sendOrderStatusEmail } from '../../../../lib/email';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { refundPayment } from '../../../../lib/mercadopago';
import { RECEIVED_STATUSES } from '../../../../lib/types';

/**
 * POST /api/admin/orders/cancel — order_number, motivo (obrigatório; "Outro" pede detalhe)
 * Cancela a compra e devolve os itens ao estoque (regra pedidos.cancelar).
 * Compra online: só com pedido do cliente (0024); estorna no Mercado Pago
 * antes de cancelar (se o estorno falhar, nada muda) e avisa o cliente.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  // o middleware já confere; de novo aqui porque é ação destrutiva
  if (!can(locals.admin, 'pedidos.cancelar')) {
    setFlash(cookies, 'erro', 'Seu cargo não permite cancelar compras.');
    return redirect(back);
  }
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  if (order.status === 'cancelled') {
    setFlash(cookies, 'erro', 'Esta compra já está cancelada.');
    return redirect(back);
  }
  const motivo = String(form.get('motivo') || '').trim();
  const detalhe = String(form.get('detalhe') || '').trim();
  const reason = motivo === 'Outro' ? detalhe : detalhe ? `${motivo} — ${detalhe}` : motivo;
  if (reason.length < 3) {
    setFlash(cookies, 'erro', 'Informe o motivo do cancelamento.');
    return redirect(back);
  }
  // compra online: só quando o próprio cliente pediu o cancelamento
  if (order.source !== 'caixa' && !order.cancel_requested_at) {
    setFlash(cookies, 'erro', 'Compra online só pode ser cancelada quando o cliente pede (em Minha conta › Pedidos).');
    return redirect(back);
  }
  // pago: devolve o dinheiro antes (estorno falhou = não cancela)
  let refundNote = '';
  if (order.source !== 'caixa' && RECEIVED_STATUSES.includes(order.status) && order.mp_payment_id) {
    const r = await refundPayment(order.mp_payment_id);
    if (!r.ok) {
      setFlash(cookies, 'erro', r.error);
      return redirect(back);
    }
    refundNote = r.simulated ? ' (pagamento de teste: nada a estornar)' : ' O valor foi estornado ao cliente pelo Mercado Pago.';
  }

  try {
    if (order.source === 'caixa') {
      await cancelCaixaSale(number);
    } else {
      const { order: updated, error } = await changeOrderStatus(number, 'cancelled');
      if (!updated) throw new Error(error || 'Falha ao cancelar.');
      await sendOrderStatusEmail(updated, 'cancelled').catch((e) => console.error('[orders/cancel] e-mail falhou:', e));
    }
  } catch (e) {
    setFlash(cookies, 'erro', e instanceof Error ? e.message : 'Não foi possível cancelar a compra.');
    return redirect(back);
  }
  await recordCancellation(number, locals.user?.id ?? null, reason);
  setFlash(cookies, 'ok', `Compra cancelada. Os itens voltaram ao estoque.${refundNote}`);
  return redirect(back);
};
