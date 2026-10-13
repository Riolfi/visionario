import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Notificações da área administrativa (migration 0014). As de estoque são
 * criadas pelo próprio banco (trigger products_stock_guard); as demais pelo
 * backend. Sem a tabela, tudo aqui vira "nada a mostrar".
 */
export interface AdminNotification {
  id: string;
  kind: string;
  message: string;
  product_id: string | null;
  order_number: string | null;
  created_at: string;
  read_at: string | null;
}

export async function unreadNotificationCount(): Promise<number> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return 0;
  const { count, error } = await sb.from('admin_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  return error ? 0 : (count ?? 0);
}

export async function listNotifications(limit = 100): Promise<AdminNotification[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const { data, error } = await sb.from('admin_notifications').select('*').order('created_at', { ascending: false }).limit(limit);
  return error ? [] : (data as AdminNotification[]);
}

export async function markAllNotificationsRead(): Promise<void> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return;
  await sb.from('admin_notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
}

export async function createNotification(n: { kind: string; message: string; order_number?: string; product_id?: string }) {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return;
  const { error } = await sb.from('admin_notifications').insert(n);
  if (error) console.error('[notifications] falhou:', error.message);
}
