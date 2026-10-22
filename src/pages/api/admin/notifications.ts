import type { APIRoute } from 'astro';
import { getNotification, markAllNotificationsRead, unreadNotificationCount, updateNotification, type NotificationAction } from '../../../lib/repo/notifications';
import { getOrderByNumber } from '../../../lib/repo/orders';
import { cancelRequestPending } from '../../../lib/order-policy';
import { json } from '../../../lib/payment-service';

const ACTIONS: NotificationAction[] = ['read', 'unread', 'archive', 'unarchive', 'delete', 'undelete'];

/**
 * POST /api/admin/notifications — { acao, id } (read, unread, archive,
 * unarchive, delete, undelete) ou { acao: 'read-all' }. Devolve o novo
 * total do sino. Regra de ouro: aviso de pedido de cancelamento ainda não
 * analisado não pode ser excluído (arquivar pode).
 */
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { acao?: string; id?: string };
  if (body.acao === 'read-all') {
    await markAllNotificationsRead();
    return json({ ok: true, unread: await unreadNotificationCount() });
  }
  const action = body.acao as NotificationAction;
  if (!ACTIONS.includes(action) || !body.id) return json({ ok: false, error: 'Ação inválida.' }, 400);
  const n = await getNotification(body.id);
  if (!n) return json({ ok: false, error: 'Notificação não encontrada.' }, 404);
  if (action === 'delete' && n.kind === 'cancelamento_solicitado' && n.order_number) {
    const order = await getOrderByNumber(n.order_number);
    if (order && cancelRequestPending(order)) {
      return json({ ok: false, error: 'Este pedido de cancelamento ainda não foi analisado: aprove ou recuse antes de excluir o aviso (dá para arquivar).' }, 409);
    }
  }
  const ok = await updateNotification(body.id, action);
  return ok ? json({ ok: true, unread: await unreadNotificationCount() }) : json({ ok: false, error: 'Rode a migration 0029 no Supabase.' }, 500);
};
