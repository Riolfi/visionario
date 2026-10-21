import type { APIRoute } from 'astro';
import { getOrderById } from '../../lib/repo/orders';
import type { BrickFormData } from '../../lib/mercadopago';
import { chargeOrder, json } from '../../lib/payment-service';

interface Body {
  /** uuid do pedido — nunca o número exibido (#13453), que é adivinhável */
  order_id?: string;
  formData?: BrickFormData;
}

/** POST /api/payments — checkout do site (Payment Brick: cartão ou Pix). */
export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: 'Requisição inválida.' }, 400);
  }
  const orderId = (body.order_id || '').trim();
  if (!orderId) return json({ error: 'Pedido não informado.' }, 400);
  const order = await getOrderById(orderId);
  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);

  const r = await chargeOrder(order, body.formData || { payment_method_id: 'pix' });
  if (r.status === 'error') return json({ error: r.error }, r.httpStatus);
  if (r.status === 'approved') return json({ status: 'approved', simulated: r.simulated, redirect: `/pedido/confirmado?id=${order.id}` });
  if (r.status === 'rejected') return json({ status: 'rejected', detail: r.detail });
  return json({ status: 'pending', pix: r.pix, order_id: order.id, order_number: order.order_number });
};
