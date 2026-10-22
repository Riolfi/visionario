import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Notificações da área administrativa (migration 0014; arquivar/excluir na
 * 0029). As de estoque são criadas pelo próprio banco (trigger
 * products_stock_guard); as demais pelo backend. Sem a tabela, tudo aqui vira
 * "nada a mostrar". Lida, arquivada e excluída valem para toda a equipe.
 */
export interface AdminNotification {
  id: string;
  kind: string;
  message: string;
  product_id: string | null;
  order_number: string | null;
  created_at: string;
  read_at: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

/** Tipo da notificação → categoria (aba/filtro) e etiqueta. */
export type NotificationCategory = 'cancelamentos' | 'estoque' | 'financeiro' | 'outros';
export const NOTIFICATION_KINDS: Record<string, { category: NotificationCategory; label: string; tone: 'red' | 'orange' | 'amber' | 'green' | 'gray' }> = {
  cancelamento_solicitado: { category: 'cancelamentos', label: 'Solicitação de cancelamento', tone: 'red' },
  cancelado_pelo_cliente: { category: 'cancelamentos', label: 'Cancelado pelo cliente', tone: 'orange' },
  devolucao_solicitada: { category: 'cancelamentos', label: 'Troca ou devolução', tone: 'orange' },
  estoque_esgotado: { category: 'estoque', label: 'Estoque esgotado', tone: 'amber' },
  estoque_baixo: { category: 'estoque', label: 'Estoque baixo', tone: 'amber' },
  pagamento_sem_estoque: { category: 'estoque', label: 'Pago sem estoque', tone: 'amber' },
  pagamento_aprovado: { category: 'financeiro', label: 'Pagamento aprovado', tone: 'green' },
  pagamento_pedido_cancelado: { category: 'financeiro', label: 'Pagamento de venda cancelada', tone: 'red' },
  cancelamento_falhou: { category: 'financeiro', label: 'Estorno sem cancelamento', tone: 'red' },
  devolucao_falhou: { category: 'financeiro', label: 'Estorno de devolução', tone: 'red' },
};
export const kindInfo = (kind: string) => NOTIFICATION_KINDS[kind] ?? { category: 'outros' as const, label: 'Aviso', tone: 'gray' as const };

/** Sino: não lidas, não arquivadas e não excluídas. */
export async function unreadNotificationCount(): Promise<number> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return 0;
  const { count, error } = await sb
    .from('admin_notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)
    .is('archived_at', null)
    .is('deleted_at', null);
  if (!error) return count ?? 0;
  // sem a 0029: só as não lidas
  const old = await sb.from('admin_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  return old.count ?? 0;
}

export async function listNotifications(opts: { archived?: boolean; limit?: number } = {}): Promise<AdminNotification[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  let q = sb.from('admin_notifications').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(opts.limit ?? 200);
  q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  const { data, error } = await q;
  if (!error) return data as AdminNotification[];
  if (opts.archived) return [];
  // sem a 0029: lista antiga
  const old = await sb.from('admin_notifications').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 200);
  return (old.data ?? []) as AdminNotification[];
}

export async function getNotification(id: string): Promise<AdminNotification | null> {
  const { data } = (await supabaseAdmin()?.from('admin_notifications').select('*').eq('id', id).maybeSingle()) ?? { data: null };
  return (data as AdminNotification | null) ?? null;
}

export type NotificationAction = 'read' | 'unread' | 'archive' | 'unarchive' | 'delete' | 'undelete';
export async function updateNotification(id: string, action: NotificationAction): Promise<boolean> {
  const sb = supabaseAdmin();
  if (!sb) return false;
  const now = new Date().toISOString();
  const patch = {
    read: { read_at: now },
    unread: { read_at: null },
    archive: { archived_at: now, read_at: now },
    unarchive: { archived_at: null },
    delete: { deleted_at: now },
    undelete: { deleted_at: null },
  }[action];
  const { error } = await sb.from('admin_notifications').update(patch).eq('id', id);
  return !error;
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
