import type { APIRoute } from 'astro';
import { getUserOrder } from '../../../lib/repo/orders';
import { createNotification } from '../../../lib/repo/notifications';
import { supabaseAdmin } from '../../../lib/supabase';
import { orderLabel } from '../../../lib/format';
import {
  CUSTOMER_CANCELABLE,
  CUSTOMER_CANCEL_REASONS,
  CUSTOMER_REQUEST_CANCEL,
  cancelOnlineOrder,
  cancelRequestPending,
  joinReason,
} from '../../../lib/order-policy';

/**
 * POST /api/account/cancelar-pedido — order_number, motivo, detalhe.
 *  - Aguardando pagamento/Pago: o cliente cancela na hora; se já pagou, o
 *    estorno sai pelo Mercado Pago (falhou = nada muda) e a equipe é avisada.
 *  - Em separação: só PEDE a desistência; a equipe é avisada e aprova
 *    (confirma que parou a separação e decide estoque/perda).
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/entrar');
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = (q: string) => redirect(`/conta/pedidos/${encodeURIComponent(number)}?${q}`);

  const order = number ? await getUserOrder(user.id, number) : null;
  if (!order) return redirect('/conta/pedidos');
  // pedido de reenvio de uma troca: não se cancela pelo site
  if (order.exchange_of) return back('cancelamento=fora');
  const direct = CUSTOMER_CANCELABLE.includes(order.status);
  if (!direct && !CUSTOMER_REQUEST_CANCEL.includes(order.status)) return back('cancelamento=fora');
  const motivo = String(form.get('motivo') || '').trim();
  if (!CUSTOMER_CANCEL_REASONS.includes(motivo)) return back('cancelamento=motivo');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return back('cancelamento=motivo');

  if (direct) {
    const r = await cancelOnlineOrder(order, user.id, `Cancelado pelo cliente: ${reason}`.slice(0, 500));
    if (!r.ok) return back('cancelamento=falha');
    await createNotification({
      kind: 'cancelado_pelo_cliente',
      message: `O cliente cancelou o pedido ${orderLabel(order.order_number)}${r.refundedCents ? ' (valor estornado)' : ''}: ${reason}`,
      order_number: order.order_number,
    });
    return back('cancelamento=feito');
  }

  if (cancelRequestPending(order)) return back('cancelamento=ja');
  const { error } = (await supabaseAdmin()
    ?.from('orders')
    .update({
      cancel_requested_at: new Date().toISOString(),
      cancel_request_reason: reason,
      cancel_request_resolved_at: null,
      cancel_request_resolved_by: null,
      cancel_request_response: null,
    })
    .eq('id', order.id)) ?? { error: new Error('sem banco') };
  if (error) return back('cancelamento=falha');

  await createNotification({
    kind: 'cancelamento_solicitado',
    message: `! Desistência em separação — pedido ${orderLabel(order.order_number)}: ${reason}. Pare a separação e aprove o cancelamento.`,
    order_number: order.order_number,
  });
  return back('cancelamento=ok');
};
