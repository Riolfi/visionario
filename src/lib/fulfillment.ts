import { confirmOrderPayment } from './repo/orders';
import { brl, orderLabel } from './format';
import { createNotification } from './repo/notifications';
import { sendOrderConfirmation } from './email';
import type { PaymentMethod } from './types';

/**
 * Pipeline único de "pedido pago": decrementa estoque (atômico/idempotente) e
 * envia o e-mail de confirmação apenas na transição pending -> paid.
 * Chamado tanto pelo /api/payments quanto pelo webhook do Mercado Pago.
 */
export async function fulfillPaidOrder(
  orderNumber: string,
  opts: { paymentId: string | null; method: PaymentMethod },
) {
  let result: Awaited<ReturnType<typeof confirmOrderPayment>>;
  try {
    result = await confirmOrderPayment(orderNumber, opts);
  } catch (err) {
    // pago, mas outra venda levou a última unidade antes: o dinheiro entrou e
    // o pedido não pôde ser confirmado — o dono precisa estornar ou repor
    const msg = err instanceof Error ? err.message : String(err);
    if (/estoque/i.test(msg)) {
      await createNotification({
        kind: 'pagamento_sem_estoque',
        message: `O pedido #${orderNumber} foi pago, mas um dos produtos acabou antes da confirmação. Reponha o estoque e marque como pago em Pedidos, ou estorne o pagamento.`,
        order_number: orderNumber,
      });
    }
    throw err;
  }
  const { order, outcome } = result;

  // venda de balcão não tem e-mail de cliente (fica "Consumidor" / vazio) —
  // não faz sentido tentar enviar confirmação
  if (outcome === 'confirmed' && order && order.source !== 'caixa') {
    // venda online paga: aviso na central (Caixa não, seria uma por venda de balcão)
    await createNotification({
      kind: 'pagamento_aprovado',
      message: `Venda ${orderLabel(orderNumber)} paga: ${brl(order.total_cents)}${order.customer_name ? ` — ${order.customer_name}` : ''}.`,
      order_number: orderNumber,
    });
    try {
      await sendOrderConfirmation(order);
    } catch (err) {
      console.error(`[fulfillment] falha ao enviar e-mail do pedido ${orderNumber}:`, err);
    }
  }

  return { order, outcome };
}
