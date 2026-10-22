import type { APIRoute } from 'astro';
import { getUserOrder } from '../../../lib/repo/orders';
import { createNotification } from '../../../lib/repo/notifications';
import { supabaseAdmin } from '../../../lib/supabase';
import { orderLabel } from '../../../lib/format';
import { RETURN_REASONS, joinReason, returnDeadline, returnOpen } from '../../../lib/order-policy';

/**
 * POST /api/account/devolucao — o cliente pede a troca ou a devolução de um
 * pedido Entregue, em até 7 dias corridos da entrega (order_number,
 * tipo=devolucao|troca, motivo, detalhe). Avisa a equipe, que aprova (com a
 * forma de devolver) ou recusa; depois de uma recusa, pode pedir de novo.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/entrar');
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = (q: string) => redirect(`/conta/pedidos/${encodeURIComponent(number)}?${q}`);

  const order = number ? await getUserOrder(user.id, number) : null;
  if (!order) return redirect('/conta/pedidos');
  const deadline = returnDeadline(order);
  if (!deadline || Date.now() > deadline.getTime()) return back('devolucao=prazo');
  if (returnOpen(order) || order.return_completed_at) return back('devolucao=ja');
  const kind = form.get('tipo') === 'troca' ? 'troca' : 'devolucao';
  const motivo = String(form.get('motivo') || '').trim();
  if (!RETURN_REASONS.includes(motivo)) return back('devolucao=motivo');
  const reason = joinReason(motivo, String(form.get('detalhe') || ''));
  if (reason.length < 3) return back('devolucao=motivo');

  const { error } = (await supabaseAdmin()
    ?.from('orders')
    .update({
      return_requested_at: new Date().toISOString(),
      return_reason: reason,
      return_kind: kind,
      // novo pedido (inclusive depois de uma recusa): limpa a análise anterior
      return_approved_at: null,
      return_approved_by: null,
      return_post_code: null,
      return_instructions: null,
      return_rejected_at: null,
      return_response: null,
    })
    .eq('id', order.id)) ?? { error: new Error('sem banco') };
  if (error) return back('devolucao=falha');

  await createNotification({
    kind: 'devolucao_solicitada',
    message: `O cliente pediu ${kind === 'troca' ? 'a troca' : 'a devolução'} do pedido ${orderLabel(order.order_number)}: ${reason}`,
    order_number: order.order_number,
  });
  return back('devolucao=ok');
};
