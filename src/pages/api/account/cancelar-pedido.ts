import type { APIRoute } from 'astro';
import { getUserOrder } from '../../../lib/repo/orders';
import { createNotification } from '../../../lib/repo/notifications';
import { orderLabel } from '../../../lib/format';
import { CUSTOMER_CANCELABLE, CUSTOMER_CANCEL_REASONS, cancelOnlineOrder, joinReason } from '../../../lib/order-policy';

/**
 * POST /api/account/cancelar-pedido — o cliente cancela a própria compra
 * online (order_number, motivo, detalhe) enquanto ela não foi enviada:
 * Aguardando pagamento, Pago ou Em separação. Se já pagou, estorna na hora
 * pelo Mercado Pago (falhou = nada muda); o estoque volta e a equipe é avisada.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/entrar');
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = (q: string) => redirect(`/conta/pedidos/${encodeURIComponent(number)}?${q}`);

  const order = number ? await getUserOrder(user.id, number) : null;
  if (!order) return redirect('/conta/pedidos');
  if (!CUSTOMER_CANCELABLE.includes(order.status)) return back('cancelamento=fora');
  const motivo = String(form.get('motivo') || '').trim();
  if (!CUSTOMER_CANCEL_REASONS.includes(motivo)) return back('cancelamento=motivo');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return back('cancelamento=motivo');

  const r = await cancelOnlineOrder(order, user.id, reason);
  if (!r.ok) return back('cancelamento=falha');

  await createNotification({
    kind: 'cancelado_pelo_cliente',
    message: `O cliente cancelou o pedido ${orderLabel(order.order_number)}${r.refundedCents ? ' (valor estornado)' : ''}: ${reason}`,
    order_number: order.order_number,
  });
  return back(r.refundedCents ? 'cancelamento=estornado' : 'cancelamento=ok');
};
