import type { APIRoute } from 'astro';
import { getNotification, updateNotification } from '../../../../lib/repo/notifications';

/** GET /api/admin/notifications/open?id= — marca como lida e abre a venda/produto do aviso. */
export const GET: APIRoute = async ({ url, redirect }) => {
  const id = url.searchParams.get('id') ?? '';
  const n = id ? await getNotification(id) : null;
  if (!n) return redirect('/admin/notificacoes');
  if (!n.read_at) await updateNotification(id, 'read');
  return redirect(n.order_number ? `/admin/pedidos/${encodeURIComponent(n.order_number)}` : n.product_id ? `/admin/produtos/${n.product_id}` : '/admin/notificacoes');
};
