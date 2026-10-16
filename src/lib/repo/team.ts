import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import type { AdminAccess } from '../rbac';
import { listAuthUsers } from './customers';
import { roleRules } from './roles';
import { getOwnerEmail, isProprietor } from './owner';
import { sendTeamPasswordEmail } from '../email';

/**
 * Equipe do painel (admin_users + cargo). Quem chega aqui tem a regra
 * equipe.gerenciar; as travas contra escalada de privilégio ficam aqui:
 * ninguém mexe no próprio acesso, só o Proprietário dá ou tira o cargo
 * Administrador (e mexe em quem o tem), e quem não é Administrador só atribui
 * cargos com regras que ele mesmo tem.
 */

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role_id: string | null;
  role_name: string;
  is_owner: boolean;
  /** inativo: continua na equipe, sem acesso a nenhuma tela (0020) */
  is_active: boolean;
  last_sign_in_at: string | null;
}

type Result = { ok: true; message?: string; id?: string } | { ok: false; error: string };
type Actor = AdminAccess & { email?: string | null };

export async function listTeam(): Promise<TeamMember[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const [{ data: rows }, users, { data: profiles }, { data: roles }] = await Promise.all([
    sb.from('admin_users').select('*'),
    listAuthUsers(),
    sb.from('profiles').select('id, full_name'),
    sb.from('admin_roles').select('id, name, is_owner'),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  const roleById = new Map((roles ?? []).map((r) => [r.id, r]));
  return (rows ?? [])
    .map((r) => {
      const role = r.role_id ? roleById.get(r.role_id) : null;
      // antes da migration 0016 (sem role_id): o "dono" do modelo anterior
      const legacyOwner = !roles && r.role !== 'equipe';
      return {
        id: r.user_id,
        email: byId.get(r.user_id)?.email ?? '—',
        name: names.get(r.user_id) || '',
        role_id: r.role_id ?? null,
        role_name: role?.name ?? (legacyOwner ? 'Administrador' : 'Sem cargo'),
        is_owner: role?.is_owner ?? legacyOwner,
        is_active: r.is_active !== false,
        last_sign_in_at: byId.get(r.user_id)?.last_sign_in_at ?? null,
      };
    })
    .sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.email.localeCompare(b.email));
}

/** Administradores ATIVOS (inativo não conta: não entra no painel). */
async function ownerCount(): Promise<number> {
  const sb = supabaseAdmin()!;
  const { data } = await sb.from('admin_users').select('*, admin_roles(is_owner)');
  return (data ?? []).filter((r) => r.is_active !== false && (r.admin_roles as unknown as { is_owner: boolean } | null)?.is_owner).length;
}

/** O cargo cabe no acesso de quem está atribuindo? (sem escalada) */
async function checkAssignable(actor: Actor, roleId: string): Promise<string | null> {
  const role = await roleRules(roleId);
  if (!role) return 'Cargo inválido.';
  if (role.isOwner) return (await isProprietor(actor.email)) ? null : 'Só o Proprietário pode dar o cargo Administrador.';
  if (actor.isOwner) return null;
  const extra = role.rules.filter((r) => !actor.rules.includes(r));
  return extra.length ? 'Esse cargo tem acessos que você não tem — só um Administrador pode atribuí-lo.' : null;
}

/** Só o Proprietário mexe em Administradores; os demais, só em quem tem acesso menor ou igual. */
async function checkManageable(actor: Actor, memberRoleId: string | null | undefined): Promise<string | null> {
  // sem cargo (depois da 0016) não tem acesso nenhum: pode receber um cargo.
  if (memberRoleId === null) return null;
  // Qualquer outra coisa que não dê pra conferir: barra (falha fechada).
  const role = memberRoleId ? await roleRules(memberRoleId) : null;
  if (!role) return actor.isOwner ? null : 'Só um Administrador pode alterar esse membro.';
  if (role.isOwner) return (await isProprietor(actor.email)) ? null : 'Só o Proprietário pode alterar um Administrador.';
  if (actor.isOwner) return null;
  return role.rules.every((r) => actor.rules.includes(r)) ? null : 'Esse membro tem acessos que você não tem — só um Administrador pode alterá-lo.';
}

/** Ninguém vira o Proprietário trocando o e-mail de uma conta: isso só pela troca com código. */
async function isOwnerEmail(email: string): Promise<boolean> {
  const owner = await getOwnerEmail();
  return !!owner && owner === email.trim().toLowerCase();
}

export async function createMember(
  actor: Actor,
  input: { name: string; email: string; password: string; roleId: string; isActive: boolean },
): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'E-mail inválido.' };
  if (await isOwnerEmail(email)) return { ok: false, error: 'Esse é o e-mail do Proprietário.' };
  const block = await checkAssignable(actor, input.roleId);
  if (block) return { ok: false, error: block };

  // Nunca promove uma conta que já existe: qualquer pessoa pode se cadastrar
  // na loja com o e-mail de um futuro funcionário (não há prova de posse do
  // e-mail), e a sessão dela viraria admin. Equipe = sempre conta nova.
  if ((await listAuthUsers()).some((u) => u.email?.toLowerCase() === email)) {
    return { ok: false, error: 'Esse e-mail já tem uma conta na loja. Use outro e-mail para a conta da equipe.' };
  }
  if (input.password.length < 8) return { ok: false, error: 'A senha inicial precisa ter pelo menos 8 caracteres.' };
  // senha temporária: no primeiro login a pessoa troca (app_metadata o usuário não altera)
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.name },
    app_metadata: { must_change_password: true },
  });
  if (error || !data.user) return { ok: false, error: error?.message ?? 'Não foi possível criar a conta.' };
  const userId = data.user.id;
  if (input.name.trim()) await sb.from('profiles').upsert({ id: userId, full_name: input.name.trim() }, { onConflict: 'id' });
  // is_active só vai quando desliga: antes da migration 0020 criar ativo continua funcionando
  const { error: e2 } = await sb
    .from('admin_users')
    .insert({ user_id: userId, role_id: input.roleId, role: 'equipe', permissions: [], ...(input.isActive ? {} : { is_active: false }) });
  if (e2) {
    await sb.auth.admin.deleteUser(userId); // não deixa conta solta sem acesso
    return { ok: false, error: /is_active/.test(e2.message) ? 'Rode a migration 0020_active_flags.sql no Supabase para criar membros inativos.' : e2.message };
  }
  const mail = await sendTeamPasswordEmail({ to: email, name: input.name, password: input.password, kind: 'welcome' });
  return {
    ok: true,
    id: userId,
    message: mail.delivered === 'resend'
      ? 'Usuário criado! Enviamos as boas-vindas com a senha temporária para o e-mail dele.'
      : 'Usuário criado, mas o e-mail de boas-vindas não foi enviado (envio de e-mail não configurado). Passe a senha temporária para a pessoa.',
  };
}

export async function updateMember(
  actor: Actor & { userId: string },
  userId: string,
  input: { name: string; email: string; password: string; roleId: string; isActive: boolean },
): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (userId === actor.userId) return { ok: false, error: 'Para alterar os seus dados, use "Meu perfil". O seu cargo só outra pessoa altera.' };
  const { data: row } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, error: 'Membro não encontrado.' };
  const manage = await checkManageable(actor, row.role_id);
  if (manage) return { ok: false, error: manage };

  if (!input.isActive && row.is_active !== false) {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    if (await isOwnerEmail(u.user?.email ?? '')) return { ok: false, error: 'O Proprietário não pode ficar inativo.' };
    if ((await roleRules(row.role_id ?? ''))?.isOwner && (await ownerCount()) <= 1) return { ok: false, error: 'O cargo Administrador precisa ter pelo menos uma pessoa ativa.' };
  }

  // cargo travado na tela (select desativado não envia): mantém o atual
  if (!input.roleId) input.roleId = row.role_id;
  if (input.roleId !== row.role_id) {
    // ninguém muda o próprio cargo (barrado acima) e só o Proprietário muda o cargo dos outros
    if (!(await isProprietor(actor.email))) return { ok: false, error: 'Só o Administrador Proprietário pode alterar o cargo de outros usuários.' };
    const block = await checkAssignable(actor, input.roleId);
    if (block) return { ok: false, error: block };
    const wasOwner = row.role_id ? (await roleRules(row.role_id))?.isOwner : false;
    const willBeOwner = (await roleRules(input.roleId))?.isOwner;
    if (wasOwner && !willBeOwner && (await ownerCount()) <= 1) return { ok: false, error: 'O cargo Administrador precisa ter pelo menos uma pessoa.' };
    // o Proprietário não perde o cargo Administrador (troque o Proprietário antes)
    if (wasOwner && !willBeOwner) {
      const { data: u } = await sb.auth.admin.getUserById(userId);
      if (await isOwnerEmail(u.user?.email ?? '')) return { ok: false, error: 'Essa pessoa é o Proprietário: troque o Proprietário em Cargos › Administrador antes.' };
    }
  }

  const auth: { email?: string; email_confirm?: boolean; password?: string } = {};
  const email = input.email.trim().toLowerCase();
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'E-mail inválido.' };
    const { data: cur } = await sb.auth.admin.getUserById(userId);
    if (email !== (cur.user?.email ?? '').toLowerCase() && (await isOwnerEmail(email))) return { ok: false, error: 'Esse é o e-mail do Proprietário.' };
    auth.email = email;
    auth.email_confirm = true;
  }
  if (input.password) {
    if (input.password.length < 8) return { ok: false, error: 'A nova senha precisa ter pelo menos 8 caracteres.' };
    auth.password = input.password;
  }
  if (Object.keys(auth).length) {
    // senha definida pelo administrador é temporária: a pessoa troca no próximo login
    const { data: cur } = await sb.auth.admin.getUserById(userId);
    const extra = input.password ? { app_metadata: { ...(cur.user?.app_metadata ?? {}), must_change_password: true } } : {};
    const { error } = await sb.auth.admin.updateUserById(userId, { ...auth, ...extra });
    if (error) return { ok: false, error: /already|registered|exists/i.test(error.message) ? 'Esse e-mail já é usado por outra conta.' : error.message };
  }
  if (input.name.trim()) await sb.from('profiles').upsert({ id: userId, full_name: input.name.trim() }, { onConflict: 'id' });
  const { error } = await sb
    .from('admin_users')
    .update({ role_id: input.roleId, role: 'equipe', permissions: [], ...(input.isActive ? {} : { is_active: false }) }) // campos antigos zerados
    .eq('user_id', userId);
  if (error) return { ok: false, error: /is_active/.test(error.message) ? 'Rode a migration 0020_active_flags.sql no Supabase para desativar membros.' : error.message };
  // reativar: grava true explicitamente (sem a coluna, ignora)
  if (input.isActive && row.is_active === false) await sb.from('admin_users').update({ is_active: true }).eq('user_id', userId);
  if (input.password) {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    const mail = await sendTeamPasswordEmail({ to: u.user?.email ?? email, name: input.name, password: input.password, kind: 'reset' });
    if (mail.delivered !== 'resend') return { ok: true, id: userId, message: 'Usuário salvo, mas o e-mail com a senha temporária não foi enviado. Passe a senha para a pessoa.' };
    return { ok: true, id: userId, message: 'Usuário salvo! Enviamos a senha temporária para o e-mail dele.' };
  }
  return { ok: true, message: 'Usuário salvo com sucesso!', id: userId };
}

/** Liga/desliga o acesso de um membro (botão da lista), com as mesmas travas da edição. */
export async function setMemberActive(actor: Actor & { userId: string }, userId: string, active: boolean): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (userId === actor.userId) return { ok: false, error: 'Você não pode ativar ou desativar a sua própria conta.' };
  const { data: row } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, error: 'Membro não encontrado.' };
  const manage = await checkManageable(actor, row.role_id);
  if (manage) return { ok: false, error: manage };
  if (!active) {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    if (await isOwnerEmail(u.user?.email ?? '')) return { ok: false, error: 'O Proprietário não pode ficar inativo.' };
    if ((await roleRules(row.role_id ?? ''))?.isOwner && (await ownerCount()) <= 1) return { ok: false, error: 'O cargo Administrador precisa ter pelo menos uma pessoa ativa.' };
  }
  const { error } = await sb.from('admin_users').update({ is_active: active }).eq('user_id', userId);
  if (error) return { ok: false, error: /is_active/.test(error.message) ? 'Rode a migration 0020_active_flags.sql no Supabase.' : error.message };
  return { ok: true, message: active ? 'Usuário ativado.' : 'Usuário desativado.' };
}

/**
 * Tira da equipe. Conta só de equipe é apagada; conta que já comprou na loja
 * continua existindo como cliente (o histórico de pedidos não se perde).
 */
export async function removeMember(actor: Actor & { userId: string }, userId: string): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (userId === actor.userId) return { ok: false, error: 'Você não pode excluir a sua própria conta.' };
  const { data: row } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, error: 'Membro não encontrado.' };
  const manage = await checkManageable(actor, row.role_id);
  if (manage) return { ok: false, error: manage };
  if (row.role_id && (await roleRules(row.role_id))?.isOwner && (await ownerCount()) <= 1) {
    return { ok: false, error: 'O cargo Administrador precisa ter pelo menos uma pessoa.' };
  }
  const { data: u } = await sb.auth.admin.getUserById(userId);
  if (await isOwnerEmail(u.user?.email ?? '')) return { ok: false, error: 'Essa pessoa é o Proprietário: troque o Proprietário em Cargos › Administrador antes.' };

  const { error } = await sb.from('admin_users').delete().eq('user_id', userId);
  if (error) return { ok: false, error: error.message };
  const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  if (count) return { ok: true, message: 'Removido da equipe. A conta continua como cliente porque tem pedidos.' };
  const { error: e2 } = await sb.auth.admin.deleteUser(userId);
  if (e2) return { ok: true, message: 'Removido da equipe, mas a conta não pôde ser apagada.' };
  return { ok: true, message: 'Membro excluído.' };
}
