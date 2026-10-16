import type { APIRoute } from 'astro';
import { getUserOrder } from '../../../lib/repo/orders';
import { createNotification } from '../../../lib/repo/notifications';
import { supabaseAdmin } from '../../../lib/supabase';
import { orderLabel } from '../../../lib/format';

/**
 * POST /api/account/cancelar-pedido — o cliente pede o cancelamento de uma
 * compra online (order_number, motivo). Não cancela: registra o pedido e avisa
 * a equipe, que confirma no painel (estorna e devolve ao estoque).
 */
const CAN_REQUEST = ['pending', 'paid', 'separating'];

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/entrar');
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const motivo = String(form.get('motivo') || '').trim();
  const detalhe = String(form.get('detalhe') || '').trim();
  const back = (q: string) => redirect(`/conta/pedidos/${encodeURIComponent(number)}?${q}`);

  const order = number ? await getUserOrder(user.id, number) : null;
  if (!order) return redirect('/conta/pedidos');
  if (!CAN_REQUEST.includes(order.status)) return back('cancelamento=fora');
  if (order.cancel_requested_at) return back('cancelamento=ja');
  const reason = (motivo === 'Outro' ? detalhe : detalhe ? `${motivo} — ${detalhe}` : motivo).slice(0, 500);
  if (reason.length < 3) return back('cancelamento=motivo');

  const { error } = (await supabaseAdmin()
    ?.from('orders')
    .update({ cancel_requested_at: new Date().toISOString(), cancel_request_reason: reason })
    .eq('id', order.id)) ?? { error: new Error('sem banco') };
  if (error) return back('cancelamento=falha');

  await createNotification({
    kind: 'cancelamento_solicitado',
    message: `O cliente pediu o cancelamento do pedido ${orderLabel(order.order_number)}: ${reason}`,
    order_number: order.order_number,
  });
  return back('cancelamento=ok');
};
