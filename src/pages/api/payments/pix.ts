import type { APIRoute } from 'astro';
import { getOrderById } from '../../../lib/repo/orders';
import { channelOf } from '../../../lib/mercadopago';
import { chargeOrder, json } from '../../../lib/payment-service';
import { can } from '../../../lib/rbac';

/**
 * POST /api/payments/pix — { order_id, channel: 'pos' | 'ecommerce' }
 * Gera o Pix de uma venda já criada e devolve { qr_code, qr_code_base64,
 * payment_id }. channel precisa bater com a venda (Caixa = pos); Pix do
 * Caixa só para quem vende no Caixa. Pagou: webhook/consulta fecham o QR.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => ({}))) as { order_id?: string; channel?: string };
  const order = body.order_id ? await getOrderById(String(body.order_id).trim()) : null;
  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  const channel = channelOf(order);
  if (body.channel !== channel) return json({ error: 'Canal não confere com a venda.' }, 400);
  if (channel === 'pos' && !can(locals.admin, 'caixa.vender')) return json({ error: 'Sem permissão para cobrar no Caixa.' }, 403);

  const r = await chargeOrder(order, { payment_method_id: 'pix' });
  if (r.status === 'error') return json({ error: r.error }, r.httpStatus);
  if (r.status === 'approved') return json({ status: 'approved', simulated: r.simulated, payment_id: r.paymentId });
  if (r.status === 'rejected') return json({ status: 'rejected', detail: r.detail, payment_id: r.paymentId });
  return json({
    status: 'pending',
    payment_id: r.paymentId,
    qr_code: r.pix?.qrCode ?? '',
    qr_code_base64: r.pix?.qrCodeBase64 ?? '',
    expires_at: r.pix?.expiresAt ?? null,
  });
};
