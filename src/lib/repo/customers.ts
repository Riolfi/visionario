import type { User } from '@supabase/supabase-js';
import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import type { Address, Order, Profile } from '../types';
import { getOrderByNumber } from './orders';

/**
 * Clientes (contas do Supabase Auth que não são da equipe) e o estado da conta
 * (migration 0013). Tudo pelo client service-role: as tabelas não têm RLS
 * policy, o cliente não lê nem altera o próprio estado.
 */

export type CustomerStatus = 'ativo' | 'desativado' | 'bloqueado';
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  ativo: 'Ativa',
  desativado: 'Desativada',
  bloqueado: 'Bloqueada',
};
const STATUSES: CustomerStatus[] = ['ativo', 'desativado', 'bloqueado'];
export const isCustomerStatus = (v: unknown): v is CustomerStatus => STATUSES.includes(v as CustomerStatus);

/**
 * Motivos prontos de cada estado (o texto vai para o histórico e, no futuro,
 * para o e-mail ao titular — por isso escrito para o cliente ler). "Outro
 * motivo" deixa escrever um texto livre.
 */
export const CUSTOMER_STATUS_REASONS: Record<CustomerStatus, string[]> = {
  ativo: [
    'Reativação solicitada pelo titular',
    'Verificação de dados concluída',
    'Pendência de pagamento resolvida',
    'Restrição aplicada por engano',
  ],
  desativado: [
    'Encerramento solicitado pelo titular',
    'Conta sem uso por longo período',
    'Dados cadastrais incompletos ou incorretos',
    'Conta duplicada',
  ],
  bloqueado: [
    'Suspeita de fraude',
    'Contestação de pagamento (chargeback)',
    'Violação dos termos de uso',
    'Uso indevido de cupons ou promoções',
  ],
};
export const OTHER_REASON = 'outro';

/** Estado da conta (sem registro = ativa). Em erro, não bloqueia ninguém. */
export async function getCustomerStatus(userId: string): Promise<CustomerStatus> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return 'ativo';
  const { data, error } = await sb.from('customer_accounts').select('status').eq('user_id', userId).maybeSingle();
  if (error) return 'ativo'; // tabela ainda não existe (migration 0013) etc.
  return isCustomerStatus(data?.status) ? data.status : 'ativo';
}

/** Todas as contas do Auth (a loja tem poucas; paginado por segurança). */
export async function listAuthUsers(): Promise<User[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const all: User[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return all;
}

export interface CustomerRow {
  id: string;
  email: string;
  name: string;
  phone: string;
  cpf: string;
  created_at: string;
  last_sign_in_at: string | null;
  status: CustomerStatus;
  orders: number;
  spent_cents: number;
}

const PAID = ['paid', 'separating', 'shipped', 'delivered'];

export async function listCustomers(): Promise<CustomerRow[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const [users, admins, profiles, accounts, orders] = await Promise.all([
    listAuthUsers(),
    sb.from('admin_users').select('user_id'),
    sb.from('profiles').select('id, full_name, phone, cpf'),
    sb.from('customer_accounts').select('user_id, status'),
    sb.from('orders').select('user_id, status, total_cents').not('user_id', 'is', null),
  ]);
  const adminIds = new Set((admins.data ?? []).map((a) => a.user_id));
  const prof = new Map((profiles.data ?? []).map((p) => [p.id, p]));
  const stat = new Map((accounts.data ?? []).map((a) => [a.user_id, a.status]));
  return users
    .filter((u) => !adminIds.has(u.id))
    .map((u) => {
      const own = (orders.data ?? []).filter((o) => o.user_id === u.id);
      const st = stat.get(u.id);
      return {
        id: u.id,
        email: u.email ?? '',
        name: prof.get(u.id)?.full_name || String(u.user_metadata?.full_name ?? ''),
        phone: prof.get(u.id)?.phone ?? '',
        cpf: prof.get(u.id)?.cpf ?? '',
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        status: isCustomerStatus(st) ? st : 'ativo',
        orders: own.length,
        spent_cents: own.filter((o) => PAID.includes(o.status)).reduce((s, o) => s + o.total_cents, 0),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export interface StatusLogEntry {
  status: CustomerStatus;
  reason: string;
  created_at: string;
  changed_by_email: string;
}

export interface CustomerDetail {
  user: User;
  isAdmin: boolean;
  profile: Profile;
  addresses: Address[];
  status: CustomerStatus;
  reason: string;
  log: StatusLogEntry[];
  /** pedidos da conta + os de convidado com o mesmo e-mail, mais novos primeiro */
  orders: Order[];
}

export async function getCustomerDetail(userId: string): Promise<CustomerDetail | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  const { data: u, error } = await sb.auth.admin.getUserById(userId);
  if (error || !u?.user) return null;
  const user = u.user;
  const email = user.email ?? '';

  const [admin, profile, addresses, account, log, byUser, byEmail] = await Promise.all([
    sb.from('admin_users').select('user_id').eq('user_id', userId).maybeSingle(),
    sb.from('profiles').select('*').eq('id', userId).maybeSingle(),
    sb.from('addresses').select('*').eq('user_id', userId).order('created_at'),
    sb.from('customer_accounts').select('status, reason').eq('user_id', userId).maybeSingle(),
    sb.from('customer_status_log').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('orders').select('order_number').eq('user_id', userId),
    email ? sb.from('orders').select('order_number').is('user_id', null).ilike('customer_email', email) : Promise.resolve({ data: [] }),
  ]);

  const numbers = [...new Set([...(byUser.data ?? []), ...(byEmail.data ?? [])].map((o) => o.order_number))];
  const orders = (await Promise.all(numbers.map((n) => getOrderByNumber(n)))).filter((o): o is Order => !!o);
  orders.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // quem fez cada mudança (e-mail), sem uma consulta por linha
  const changers = [...new Set((log.data ?? []).map((l) => l.changed_by).filter(Boolean))] as string[];
  const changerEmail = new Map<string, string>();
  await Promise.all(
    changers.map(async (id) => {
      const { data } = await sb.auth.admin.getUserById(id);
      changerEmail.set(id, data?.user?.email ?? '—');
    }),
  );

  const p = profile.data;
  return {
    user,
    isAdmin: !!admin.data,
    profile: { id: userId, full_name: p?.full_name ?? '', phone: p?.phone ?? '', cpf: p?.cpf ?? '' },
    addresses: (addresses.data ?? []) as Address[],
    status: isCustomerStatus(account.data?.status) ? account.data!.status : 'ativo',
    reason: account.data?.reason ?? '',
    log: (log.data ?? []).map((l) => ({
      status: l.status,
      reason: l.reason,
      created_at: l.created_at,
      changed_by_email: l.changed_by ? changerEmail.get(l.changed_by) ?? '—' : '—',
    })),
    orders,
  };
}

/**
 * Muda o estado da conta, registra no histórico e aplica no login:
 * desativada/bloqueada fica impedida de entrar (ban no Supabase Auth) e quem
 * já está logado é barrado no próximo clique (middleware).
 */
export async function setCustomerStatus(
  userId: string,
  status: CustomerStatus,
  reason: string,
  changedBy: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const { data: admin } = await sb.from('admin_users').select('user_id').eq('user_id', userId).maybeSingle();
  if (admin) return { ok: false, error: 'Essa conta é da equipe — gerencie na aba Equipe.' };

  const now = new Date().toISOString();
  const { error: e1 } = await sb
    .from('customer_accounts')
    .upsert({ user_id: userId, status, reason, updated_at: now, updated_by: changedBy }, { onConflict: 'user_id' });
  if (e1) return { ok: false, error: e1.message };
  const { error: e2 } = await sb.from('customer_status_log').insert({ user_id: userId, status, reason, changed_by: changedBy });
  if (e2) return { ok: false, error: e2.message };
  // ~100 anos = até alguém reativar
  const { error: e3 } = await sb.auth.admin.updateUserById(userId, { ban_duration: status === 'ativo' ? 'none' : '876000h' });
  if (e3) return { ok: false, error: e3.message };
  return { ok: true };
}
