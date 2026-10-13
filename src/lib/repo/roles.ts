import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { isRuleKey, type RuleKey } from '../rbac';

/**
 * Permissões (grupos de regras por tela) e Cargos (conjuntos de permissões).
 * Só o Dono chega às telas que usam isto (ver canAccess). Migration 0016.
 */

type Result = { ok: true; id?: string } | { ok: false; error: string };

export interface Permission {
  id: string;
  /** legado (0016): tela de origem; as novas são 'geral' */
  screen: string;
  name: string;
  description: string;
  rules: RuleKey[];
}

export interface Role {
  id: string;
  name: string;
  description: string;
  is_owner: boolean;
  permission_ids: string[];
  members: number;
}


export async function listPermissions(): Promise<Permission[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const { data, error } = await sb.from('admin_permissions').select('*').order('name');
  if (error) throw error;
  return (data ?? []).map((p) => ({ ...p, rules: (p.rules ?? []).filter(isRuleKey) }));
}

export async function getPermission(id: string): Promise<Permission | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await sb.from('admin_permissions').select('*').eq('id', id).maybeSingle();
  return data ? { ...data, rules: (data.rules ?? []).filter(isRuleKey) } : null;
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
export async function savePermission(input: { id?: string; name: string; description: string; rules: unknown[] }): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) return { ok: false, error: 'Dê um nome para a permissão.' };
  const rules = [...new Set(input.rules.filter(isRuleKey))];
  if (!rules.length) return { ok: false, error: 'Ligue pelo menos uma regra.' };
  // nome único (a constraint antiga é por tela+nome)
  const { data: same } = await sb.from('admin_permissions').select('id').ilike('name', name);
  if ((same ?? []).some((p) => p.id !== input.id)) return { ok: false, error: 'Já existe uma permissão com esse nome.' };
  const row = { name, description: input.description.trim().slice(0, 200), rules };
  const { data, error } = input.id
    ? await sb.from('admin_permissions').update(row).eq('id', input.id).select('id').single()
    : await sb.from('admin_permissions').insert({ ...row, screen: 'geral' }).select('id').single();
  if (error) return { ok: false, error: error.message };
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
    .select('is_owner, admin_role_permissions(admin_permissions(rules))')
    .eq('id', roleId)
    .maybeSingle();
  if (!data) return null;
  const rules = new Set<RuleKey>();
  for (const rp of (data.admin_role_permissions ?? []) as unknown as { admin_permissions: { rules: string[] } | null }[]) {
    for (const r of rp.admin_permissions?.rules ?? []) if (isRuleKey(r)) rules.add(r);
  }
  return { isOwner: data.is_owner, rules: [...rules] };
}

export async function saveRole(input: { id?: string; name: string; description: string; permissionIds: unknown[] }): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const name = input.name.trim().slice(0, 60);
  if (name.length < 2) return { ok: false, error: 'Dê um nome para o cargo.' };
  if (input.id) {
    const { data: cur } = await sb.from('admin_roles').select('is_owner').eq('id', input.id).maybeSingle();
    if (!cur) return { ok: false, error: 'Cargo não encontrado.' };
    if (cur.is_owner) return { ok: false, error: 'O cargo Dono tem acesso total e não pode ser alterado.' };
  }
  const { data: perms } = await sb.from('admin_permissions').select('id');
  const valid = new Set((perms ?? []).map((p) => p.id));
  const permissionIds = [...new Set(input.permissionIds.map(String))].filter((id) => valid.has(id));

  const row = { name, description: input.description.trim().slice(0, 200) };
  const { data, error } = input.id
    ? await sb.from('admin_roles').update(row).eq('id', input.id).select('id').single()
    : await sb.from('admin_roles').insert(row).select('id').single();
  if (error) return { ok: false, error: /duplicate|unique/i.test(error.message) ? 'Já existe um cargo com esse nome.' : error.message };

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

export async function deleteRole(id: string): Promise<Result & { members?: number }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const { data: cur } = await sb.from('admin_roles').select('is_owner').eq('id', id).maybeSingle();
  if (!cur) return { ok: false, error: 'Cargo não encontrado.' };
  if (cur.is_owner) return { ok: false, error: 'O cargo Dono não pode ser excluído.' };
  // quem tinha esse cargo fica sem cargo (sem acesso a telas) — on delete set null
  const { error } = await sb.from('admin_roles').delete().eq('id', id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
