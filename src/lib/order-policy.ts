/**
 * Política de cancelamento e devolução (compras online e do Caixa).
 *
 *  - Cliente cancela sozinho até ser enviado (Aguardando pagamento, Pago,
 *    Em separação); se já pagou, o estorno sai na hora pelo Mercado Pago.
 *  - Enviado/Entregue: não cancela; Entregue abre a devolução por 7 dias
 *    corridos (CDC, art. 49), contados de delivered_at.
 *  - A equipe cancela compra online antes do envio com motivo; Caixa, sempre.
 *  - Cancelado é final (o banco também recusa, migration 0025).
 */
import { changeOrderStatus, recordCancellation } from './repo/orders';
import { createNotification } from './repo/notifications';
import { refundPayment } from './mercadopago';
import { sendOrderStatusEmail } from './email';
import { orderLabel } from './format';
import { RECEIVED_STATUSES, type Order, type OrderStatus } from './types';

export const CUSTOMER_CANCELABLE: OrderStatus[] = ['pending', 'paid', 'separating'];
/** a equipe ainda cancela pagamento não concluído; depois de enviado, só devolução */
export const STAFF_CANCELABLE_ONLINE: OrderStatus[] = ['pending', 'paid', 'separating', 'failed'];
export const RETURN_DAYS = 7;

export { CUSTOMER_CANCEL_REASONS, RETURN_REASONS, CANCEL_REASONS_ONLINE, CANCEL_REASONS_CAIXA, joinReason } from './types';

/** Prazo final da devolução (7 dias corridos depois da entrega); null fora de Entregue. */
export function returnDeadline(order: Order): Date | null {
  if (order.status !== 'delivered') return null;
  const base = order.delivered_at ?? order.updated_at;
  return base ? new Date(new Date(base).getTime() + RETURN_DAYS * 86_400_000) : null;
}

/**
 * Cancela uma compra online: estorna no Mercado Pago se já foi paga (estorno
 * falhou = nada muda), põe Cancelado (o estoque volta se já tinha baixado),
 * grava quem/quando/motivo e avisa o cliente com os dados do reembolso.
 * `by` é o id de quem fez (o próprio cliente ou alguém da equipe).
 */
export async function cancelOnlineOrder(
  order: Order,
  by: string | null,
  reason: string,
): Promise<{ ok: true; refundedCents: number | null; simulated?: boolean } | { ok: false; error: string }> {
  if (!STAFF_CANCELABLE_ONLINE.includes(order.status)) {
    return { ok: false, error: 'Pedido já enviado ou finalizado: não dá para cancelar. Para devolver, use a solicitação de devolução.' };
  }
  const paid = RECEIVED_STATUSES.includes(order.status);
  let refundedCents: number | null = null;
  let simulated = false;
  if (paid && order.mp_payment_id) {
    const r = await refundPayment(order.mp_payment_id);
    if (!r.ok) return { ok: false, error: r.error };
    refundedCents = order.total_cents;
    simulated = !!r.simulated;
  }
  const { order: updated, error } = await changeOrderStatus(order.order_number, 'cancelled');
  if (!updated) {
    // o dinheiro já voltou, mas o status não mudou: a equipe precisa ver
    if (refundedCents) {
      await createNotification({
        kind: 'cancelamento_falhou',
        message: `O pedido ${orderLabel(order.order_number)} foi estornado, mas não ficou como Cancelado (${error ?? 'erro'}). Cancele de novo no painel.`,
        order_number: order.order_number,
      });
    }
    return { ok: false, error: error || 'Não foi possível cancelar.' };
  }
  await recordCancellation(order.order_number, by, reason);
  await sendOrderStatusEmail(updated, 'cancelled', { refundCents: refundedCents }).catch((e) =>
    console.error('[cancel] e-mail falhou:', e),
  );
  return { ok: true, refundedCents, simulated };
}
