import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { SECTION_KEYS, type AdminRole, type AdminSection } from './admin';
import { listAuthUsers } from './customers';

/** Equipe do painel (admin_users + dados da conta). Só o dono chega aqui. */

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  permissions: AdminSection[];
  last_sign_in_at: string | null;
}

type Result = { ok: true; message?: string } | { ok: false; error: string };

const cleanPermissions = (raw: unknown[]): AdminSection[] =>
  SECTION_KEYS.filter((k) => raw.includes(k));

export async function listTeam(): Promise<TeamMember[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const [{ data: rows }, users, { data: profiles }] = await Promise.all([
    sb.from('admin_users').select('*'),
    listAuthUsers(),
    sb.from('profiles').select('id, full_name'),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  return (rows ?? [])
    .map((r) => {
      const u = byId.get(r.user_id);
      const role: AdminRole = r.role === 'equipe' ? 'equipe' : 'dono';
      return {
        id: r.user_id,
        email: u?.email ?? '—',
        name: names.get(r.user_id) || '',
        role,
        permissions: role === 'dono' ? [...SECTION_KEYS] : cleanPermissions(r.permissions ?? []),
        last_sign_in_at: u?.last_sign_in_at ?? null,
      };
    })
    .sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'dono' ? -1 : 1));
}

async function ownerCount(): Promise<number> {
  const sb = supabaseAdmin()!;
  const { data } = await sb.from('admin_users').select('*');
  return (data ?? []).filter((r) => r.role !== 'equipe').length;
}

export async function createMember(input: {
  name: string;
  email: string;
  password: string;
  role: AdminRole;
  permissions: unknown[];
}): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'E-mail inválido.' };
  const permissions = input.role === 'dono' ? [] : cleanPermissions(input.permissions);

  // Nunca promove uma conta que já existe: qualquer pessoa pode se cadastrar
  // na loja com o e-mail de um futuro funcionário (não há prova de posse do
  // e-mail), e a sessão dela viraria admin. Equipe = sempre conta nova, com a
  // senha definida pelo dono.
  if ((await listAuthUsers()).some((u) => u.email?.toLowerCase() === email)) {
    return { ok: false, error: 'Esse e-mail já tem uma conta na loja. Use outro e-mail para a conta da equipe.' };
  }
  if (input.password.length < 8) return { ok: false, error: 'A senha inicial precisa ter pelo menos 8 caracteres.' };
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.name },
  });
  if (error || !data.user) return { ok: false, error: error?.message ?? 'Não foi possível criar a conta.' };
  const userId = data.user.id;
  if (input.name.trim()) await sb.from('profiles').upsert({ id: userId, full_name: input.name.trim() }, { onConflict: 'id' });
  const { error: e2 } = await sb.from('admin_users').insert({ user_id: userId, role: input.role, permissions });
  if (e2) {
    await sb.auth.admin.deleteUser(userId); // não deixa conta solta sem acesso
    return { ok: false, error: e2.message };
  }
  return { ok: true };
}

export async function updateMember(
  actorId: string,
  userId: string,
  input: { name: string; email: string; password: string; role: AdminRole; permissions: unknown[] },
): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const { data: row } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, error: 'Membro não encontrado.' };
  const wasOwner = row.role !== 'equipe';
  if (wasOwner && input.role === 'equipe') {
    if (userId === actorId) return { ok: false, error: 'Você não pode tirar o seu próprio papel de dono.' };
    if ((await ownerCount()) <= 1) return { ok: false, error: 'A loja precisa ter pelo menos um dono.' };
  }

  const auth: { email?: string; email_confirm?: boolean; password?: string } = {};
  const email = input.email.trim().toLowerCase();
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'E-mail inválido.' };
    auth.email = email;
    auth.email_confirm = true;
  }
  if (input.password) {
    if (input.password.length < 8) return { ok: false, error: 'A nova senha precisa ter pelo menos 8 caracteres.' };
    auth.password = input.password;
  }
  if (Object.keys(auth).length) {
    const { error } = await sb.auth.admin.updateUserById(userId, auth);
    if (error) return { ok: false, error: /already|registered|exists/i.test(error.message) ? 'Esse e-mail já é usado por outra conta.' : error.message };
  }
  if (input.name.trim()) await sb.from('profiles').upsert({ id: userId, full_name: input.name.trim() }, { onConflict: 'id' });
  const permissions = input.role === 'dono' ? [] : cleanPermissions(input.permissions);
  const { error } = await sb.from('admin_users').update({ role: input.role, permissions }).eq('user_id', userId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Tira da equipe. Conta só de equipe é apagada; conta que já comprou na loja
 * continua existindo como cliente (o histórico de pedidos não se perde).
 */
export async function removeMember(actorId: string, userId: string): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (userId === actorId) return { ok: false, error: 'Você não pode excluir a sua própria conta.' };
  const { data: row } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, error: 'Membro não encontrado.' };
  if (row.role !== 'equipe' && (await ownerCount()) <= 1) return { ok: false, error: 'A loja precisa ter pelo menos um dono.' };

  const { error } = await sb.from('admin_users').delete().eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (count) return { ok: true, message: 'Removido da equipe. A conta continua como cliente porque tem pedidos.' };
  const { error: e2 } = await sb.auth.admin.deleteUser(userId);
  if (e2) return { ok: true, message: 'Removido da equipe, mas a conta não pôde ser apagada.' };
  return { ok: true, message: 'Membro excluído.' };
}
