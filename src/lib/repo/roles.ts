import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { isRuleKey, type AdminAccess, type RuleKey } from '../rbac';

/**
 * Permissões (grupos de regras por tela) e Cargos (conjuntos de permissões).
 * Permissões: só o Administrador; Cargos: Administrador ou regra cargos.editar
 * (ver canAccess). Migrations 0016, 0018 e 0019.
 */

type Result = { ok: true; id?: string } | { ok: false; error: string; existingId?: string };

export interface Permission {
  id: string;
  /** legado (0016): tela de origem; as novas são 'geral' */
  screen: string;
  name: string;
  description: string;
  rules: RuleKey[];
  /** inativa não dá regra a ninguém (0018; antes dela, sempre ativa) */
  is_active: boolean;
}

const toPermission = (p: any): Permission => ({ ...p, rules: (p.rules ?? []).filter(isRuleKey), is_active: p.is_active !== false });

export interface Role {
  id: string;
  name: string;
  description: string;
  is_owner: boolean;
  /** inativo: quem tem fica sem acesso (0019; antes dela, sempre ativo) */
  is_active: boolean;
  /** só no Administrador: e-mail do Proprietário */
  owner_email: string | null;
  permission_ids: string[];
  members: number;
}


export async function listPermissions(): Promise<Permission[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const { data, error } = await sb.from('admin_permissions').select('*').order('name');
  if (error) throw error;
  return (data ?? []).map(toPermission);
}

export async function getPermission(id: string): Promise<Permission | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await sb.from('admin_permissions').select('*').eq('id', id).maybeSingle();
  return data ? toPermission(data) : null;
}

/** Nomes dos cargos que usam a permissão (não deixa excluir se houver). */
export async function rolesUsingPermission(id: string): Promise<string[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const { data } = await sb.from('admin_role_permissions').select('admin_roles(name)').eq('permission_id', id);
  return (data ?? []).map((r) => (r.admin_roles as unknown as { name: string } | null)?.name ?? '').filter(Boolean);
}

/**
 * Permissão = grupo de regras de qualquer tela. A coluna `screen` (0016)
 * virou legado: as novas ficam como 'geral'.
 */
export async function savePermission(input: { id?: string; name: string; description: string; rules: unknown[]; is_active: boolean }): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) return { ok: false, error: 'Dê um nome para a permissão.' };
  const rules = [...new Set(input.rules.filter(isRuleKey))];
  if (!rules.length) return { ok: false, error: 'Ligue pelo menos uma regra.' };
  // nome único (a constraint antiga é por tela+nome)
  const { data: same } = await sb.from('admin_permissions').select('id').ilike('name', name);
  if ((same ?? []).some((p) => p.id !== input.id)) return { ok: false, error: 'Já existe uma permissão com esse nome.' };
  // mesmas regras de outra permissão: seria só um nome a mais pro mesmo acesso
  const key = [...rules].sort().join(',');
  const { data: all } = await sb.from('admin_permissions').select('id, rules');
  const twin = (all ?? []).find((p) => p.id !== input.id && [...(p.rules ?? [])].sort().join(',') === key);
  if (twin) return { ok: false, error: 'Já existe uma permissão com as mesmas regras.', existingId: twin.id };
  // is_active só vai quando desliga: antes da migration 0018 salvar ativa continua funcionando
  const row = { name, description: input.description.trim().slice(0, 200), rules, ...(input.is_active ? {} : { is_active: false }) };
  const { data, error } = input.id
    ? await sb.from('admin_permissions').update(row).eq('id', input.id).select('id').single()
    : await sb.from('admin_permissions').insert({ ...row, screen: 'geral' }).select('id').single();
  if (error) return { ok: false, error: /is_active/.test(error.message) ? 'Rode a migration 0018_permission_active.sql no Supabase para desativar permissões.' : error.message };
  // reativar: precisa gravar true explicitamente
  if (input.id && input.is_active) await sb.from('admin_permissions').update({ is_active: true }).eq('id', data.id).then(() => {}, () => {});
  return { ok: true, id: data.id };
}

export async function deletePermission(id: string): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const used = await rolesUsingPermission(id);
  if (used.length) return { ok: false, error: `Não dá para excluir: os cargos ${used.join(', ')} usam esta permissão. Tire dela desses cargos antes.` };
  const { error } = await sb.from('admin_permissions').delete().eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function listRoles(): Promise<Role[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const [{ data: roles, error }, { data: links }, { data: members }] = await Promise.all([
    sb.from('admin_roles').select('*').order('is_owner', { ascending: false }).order('name'),
    sb.from('admin_role_permissions').select('role_id, permission_id'),
    sb.from('admin_users').select('role_id'),
  ]);
  if (error) throw error;
  return (roles ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    is_owner: r.is_owner,
    is_active: r.is_active !== false,
    owner_email: r.owner_email ?? null,
    permission_ids: (links ?? []).filter((l) => l.role_id === r.id).map((l) => l.permission_id),
    members: (members ?? []).filter((m) => m.role_id === r.id).length,
  }));
}

/** Regras de um cargo (para conferir escalada de privilégio na equipe). */
export async function roleRules(roleId: string): Promise<{ isOwner: boolean; rules: RuleKey[] } | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  const { data } = await sb
    .from('admin_roles')
    .select('is_owner, admin_role_permissions(admin_permissions(*))')
    .eq('id', roleId)
    .maybeSingle();
  if (!data) return null;
  const rules = new Set<RuleKey>();
  for (const rp of (data.admin_role_permissions ?? []) as unknown as { admin_permissions: { rules: string[]; is_active?: boolean } | null }[]) {
    if (rp.admin_permissions?.is_active === false) continue;
    for (const r of rp.admin_permissions?.rules ?? []) if (isRuleKey(r)) rules.add(r);
  }
  return { isOwner: data.is_owner, rules: [...rules] };
}

/** Regras que um conjunto de permissões dá (ativas ou não: na trava conta tudo). */
async function rulesOfPermissions(ids: string[]): Promise<RuleKey[]> {
  const sb = supabaseAdmin()!;
  if (!ids.length) return [];
  const { data } = await sb.from('admin_permissions').select('rules').in('id', ids);
  return [...new Set((data ?? []).flatMap((p) => (p.rules ?? []).filter(isRuleKey)))];
}

/**
 * Quem não é Administrador (tem só "Criar e editar cargos") não escala:
 * não mexe no Administrador nem no próprio cargo, e só usa permissões cujas
 * regras ele mesmo tem.
 */
async function checkRoleEditable(actor: AdminAccess, roleId: string | undefined, permissionIds: string[]): Promise<string | null> {
  if (actor.isOwner) return null;
  if (roleId) {
    if (roleId === actor.roleId) return 'Você não pode alterar o seu próprio cargo.';
    const cur = await roleRules(roleId);
    if (!cur) return 'Cargo não encontrado.';
    if (cur.isOwner) return 'Só um Administrador pode alterar o cargo Administrador.';
    if (cur.rules.some((r) => !actor.rules.includes(r))) return 'Esse cargo tem acessos que você não tem.';
  }
  const extra = (await rulesOfPermissions(permissionIds)).filter((r) => !actor.rules.includes(r));
  return extra.length ? 'Você só pode usar permissões com acessos que você mesmo tem.' : null;
}

export async function saveRole(
  actor: AdminAccess,
  input: { id?: string; name: string; description: string; permissionIds: unknown[]; is_active: boolean },
): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const name = input.name.trim().slice(0, 60);
  if (name.length < 2) return { ok: false, error: 'Dê um nome para o cargo.' };
  const { data: perms } = await sb.from('admin_permissions').select('id');
  const valid = new Set((perms ?? []).map((p) => p.id));
  const permissionIds = [...new Set(input.permissionIds.map(String))].filter((id) => valid.has(id));

  let isOwnerRole = false;
  if (input.id) {
    const { data: cur } = await sb.from('admin_roles').select('is_owner').eq('id', input.id).maybeSingle();
    if (!cur) return { ok: false, error: 'Cargo não encontrado.' };
    isOwnerRole = cur.is_owner;
  }
  const block = await checkRoleEditable(actor, input.id, isOwnerRole ? [] : permissionIds);
  if (block) return { ok: false, error: block };

  // mesmo nome E mesmas permissões de outro cargo: aponta para o existente
  const key = [...permissionIds].sort().join(',');
  const { data: sameName } = await sb.from('admin_roles').select('id').ilike('name', name);
  for (const r of (sameName ?? []).filter((r) => r.id !== input.id)) {
    const { data: l } = await sb.from('admin_role_permissions').select('permission_id').eq('role_id', r.id);
    const other = (l ?? []).map((x) => x.permission_id).sort().join(',');
    if (other === key) return { ok: false, error: 'Já existe um cargo com esse nome e regras.', existingId: r.id };
    return { ok: false, error: 'Já existe um cargo com esse nome.' };
  }

  // Administrador: só nome e descrição (acesso total sempre; nunca fica inativo).
  // is_active só vai quando desliga: antes da migration 0019 salvar ativo continua funcionando.
  const row = {
    name,
    description: input.description.trim().slice(0, 200),
    ...(isOwnerRole || input.is_active ? {} : { is_active: false }),
  };
  const { data, error } = input.id
    ? await sb.from('admin_roles').update(row).eq('id', input.id).select('id').single()
    : await sb.from('admin_roles').insert(row).select('id').single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) return { ok: false, error: 'Já existe um cargo com esse nome.' };
    return { ok: false, error: /is_active/.test(error.message) ? 'Rode a migration 0019_admin_owner.sql no Supabase para desativar cargos.' : error.message };
  }
  // reativar: precisa gravar true explicitamente (sem a coluna, ignora)
  if (input.id && input.is_active && !isOwnerRole) await sb.from('admin_roles').update({ is_active: true }).eq('id', data.id).then(() => {}, () => {});
  if (isOwnerRole) return { ok: true, id: data.id };

  const { error: delErr } = await sb.from('admin_role_permissions').delete().eq('role_id', data.id);
  if (delErr) return { ok: false, error: delErr.message };
  if (permissionIds.length) {
    const { error: insErr } = await sb
      .from('admin_role_permissions')
      .insert(permissionIds.map((permission_id) => ({ role_id: data.id, permission_id })));
    if (insErr) return { ok: false, error: insErr.message };
  }
  return { ok: true, id: data.id };
}

export async function deleteRole(actor: AdminAccess, id: string): Promise<Result & { members?: number }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const { data: cur } = await sb.from('admin_roles').select('is_owner').eq('id', id).maybeSingle();
  if (!cur) return { ok: false, error: 'Cargo não encontrado.' };
  if (cur.is_owner) return { ok: false, error: 'O cargo Administrador não pode ser excluído.' };
  const block = await checkRoleEditable(actor, id, []);
  if (block) return { ok: false, error: block };
  const { count } = await sb.from('admin_users').select('user_id', { count: 'exact', head: true }).eq('role_id', id);
  if (count) return { ok: false, error: `Não dá para excluir: ${count} ${count === 1 ? 'pessoa tem' : 'pessoas têm'} esse cargo. Troque o cargo delas em Usuários › Equipe primeiro.`, members: count };
  const { error } = await sb.from('admin_roles').delete().eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
