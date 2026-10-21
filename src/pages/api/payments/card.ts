import type { APIRoute } from 'astro';
import { getOrderById } from '../../../lib/repo/orders';
import { channelOf, type BrickFormData } from '../../../lib/mercadopago';
import { chargeOrder, json } from '../../../lib/payment-service';

/**
 * POST /api/payments/card — { order_id, formData } do Payment Brick (token do
 * cartão gerado pelo Mercado Pago no navegador, parcelas, bandeira).
 * Só compra do site: no Caixa o cartão é na maquininha (baixa manual).
 */
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { order_id?: string; formData?: BrickFormData };
  const order = body.order_id ? await getOrderById(String(body.order_id).trim()) : null;
  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (channelOf(order) !== 'ecommerce') return json({ error: 'No Caixa, o cartão é passado na maquininha.' }, 400);
  const form = body.formData;
  if (!form?.token || !form.payment_method_id || form.payment_method_id === 'pix') return json({ error: 'Dados do cartão incompletos.' }, 400);

  const r = await chargeOrder(order, form);
  if (r.status === 'error') return json({ error: r.error }, r.httpStatus);
  if (r.status === 'approved') return json({ status: 'approved', simulated: r.simulated, payment_id: r.paymentId, redirect: `/pedido/confirmado?id=${order.id}` });
  if (r.status === 'rejected') return json({ status: 'rejected', detail: r.detail, payment_id: r.paymentId });
  return json({ status: 'pending', payment_id: r.paymentId });
};
