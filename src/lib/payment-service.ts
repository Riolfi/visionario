import { setOrderStatus } from './repo/orders';
import { MpError, processPayment, rejectionMessage, type BrickFormData } from './mercadopago';
import { fulfillPaidOrder } from './fulfillment';
import type { Order, PaymentMethod } from './types';

/**
 * Cobra uma venda já criada (site ou Caixa) e aplica o resultado:
 * aprovado (ou simulado) = Pago + baixa de estoque; recusado = não concluído;
 * pendente (Pix) = devolve o QR Code e o webhook/consulta confirmam depois.
 * Usado por /api/payments, /api/payments/pix e /api/payments/card.
 */
export type ChargeResult =
  | { status: 'approved'; simulated: boolean; paymentId: string | null }
  | { status: 'rejected'; detail: string; paymentId: string | null }
  | { status: 'pending'; paymentId: string | null; pix: { qrCode: string; qrCodeBase64: string; ticketUrl: string; expiresAt: string | null } | null }
  | { status: 'error'; error: string; httpStatus: number };

const normalizeMethod = (m: string): PaymentMethod => (m === 'pix' ? 'pix' : m === 'simulado' ? 'simulado' : m === 'debit_card' ? 'debit_card' : 'credit_card');

export async function chargeOrder(order: Order, form: BrickFormData): Promise<ChargeResult> {
  if (order.status === 'cancelled') return { status: 'error', error: 'Este pedido foi cancelado.', httpStatus: 409 };
  if (order.status !== 'pending' && order.status !== 'failed') return { status: 'approved', simulated: false, paymentId: order.mp_payment_id ?? null };
  try {
    const result = await processPayment(order, form);
    if (result.status === 'approved' || result.status === 'simulado') {
      await fulfillPaidOrder(order.order_number, { paymentId: result.paymentId, method: normalizeMethod(result.method) });
      return { status: 'approved', simulated: result.status === 'simulado', paymentId: result.paymentId };
    }
    if (result.status === 'rejected') {
      await setOrderStatus(order.order_number, 'failed');
      // texto para o cliente; o código cru (status_detail) fica no histórico de pagamentos
      return { status: 'rejected', detail: rejectionMessage(result.detail), paymentId: result.paymentId };
    }
    // pending / in_process (típico do Pix aguardando o cliente pagar)
    return { status: 'pending', paymentId: result.paymentId, pix: result.pix ?? null };
  } catch (err) {
    console.error('[payment-service] erro:', err);
    return {
      status: 'error',
      error: err instanceof MpError ? err.message : 'Não foi possível processar o pagamento. Tente novamente.',
      httpStatus: 502,
    };
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
