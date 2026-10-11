import type { APIRoute } from 'astro';
import { getOrderById, setOrderStatus } from '../../lib/repo/orders';
import { processPayment, type BrickFormData } from '../../lib/mercadopago';
import { fulfillPaidOrder } from '../../lib/fulfillment';
import type { PaymentMethod } from '../../lib/types';

interface Body {
  /** uuid do pedido — nunca o número exibido (#13453), que é adivinhável */
  order_id?: string;
  formData?: BrickFormData;
}

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

  if (order.status === 'paid') {
    return json({ status: 'approved', redirect: `/pedido/confirmado?id=${order.id}` });
  }
  if (order.status === 'cancelled') {
    return json({ error: 'Este pedido foi cancelado.' }, 409);
  }

  const form: BrickFormData = body.formData || { payment_method_id: 'pix' };

  try {
    const result = await processPayment(order, form);
    const method = normalizeMethod(result.method);

    if (result.status === 'approved' || result.status === 'simulado') {
      await fulfillPaidOrder(order.order_number, { paymentId: result.paymentId, method });
      return json({
        status: 'approved',
        simulated: result.status === 'simulado',
        redirect: `/pedido/confirmado?id=${order.id}`,
      });
    }

    if (result.status === 'rejected') {
      await setOrderStatus(order.order_number, 'failed');
      return json({ status: 'rejected', detail: result.detail ?? 'Pagamento recusado.' });
    }

    // pending / in_process  (típico do Pix aguardando compensação)
    return json({
      status: 'pending',
      pix: result.pix ?? null,
      order_id: order.id,
      order_number: order.order_number,
    });
  } catch (err) {
    console.error('[api/payments] erro:', err);
    return json({ error: 'Não foi possível processar o pagamento. Tente novamente.' }, 502);
  }
};

function normalizeMethod(method: string): PaymentMethod {
  if (method === 'pix') return 'pix';
  if (method === 'simulado') return 'simulado';
  return 'credit_card';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
