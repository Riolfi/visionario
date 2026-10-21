import type { APIRoute } from 'astro';
import { getUserOrder } from '../../../lib/repo/orders';
import { createNotification } from '../../../lib/repo/notifications';
import { supabaseAdmin } from '../../../lib/supabase';
import { orderLabel } from '../../../lib/format';
import { CUSTOMER_CANCELABLE, CUSTOMER_CANCEL_REASONS, cancelRequestPending, joinReason } from '../../../lib/order-policy';

/**
 * POST /api/account/cancelar-pedido — o cliente PEDE o cancelamento de uma
 * compra online (order_number, motivo, detalhe) enquanto ela está Aguardando
 * pagamento ou Pago. Nada é cancelado nem estornado aqui: a equipe analisa,
 * aprova (cancela, estorna e decide o estoque) ou recusa com uma resposta.
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
  if (cancelRequestPending(order)) return back('cancelamento=ja');
  const motivo = String(form.get('motivo') || '').trim();
  if (!CUSTOMER_CANCEL_REASONS.includes(motivo)) return back('cancelamento=motivo');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return back('cancelamento=motivo');

  // novo pedido (inclusive depois de uma recusa): limpa a análise anterior
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
    message: `! Solicitação de Cancelamento Pendente — pedido ${orderLabel(order.order_number)}: ${reason}`,
    order_number: order.order_number,
  });
  return back('cancelamento=ok');
};
