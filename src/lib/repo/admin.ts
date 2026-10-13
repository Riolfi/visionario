import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { RULE_KEYS, isRuleKey, type AdminAccess, type RuleKey } from '../rbac';

export { canAccess, homeFor, can, type AdminAccess } from '../rbac';

/**
 * Acesso de uma conta à área administrativa: cargo → permissões → regras
 * (migration 0016). Sempre reconsulta o banco — nunca confia no cliente. As
 * tabelas não têm RLS policy: só o client service-role (usado aqui) lê.
 * Sem a migration 0016, cai no modelo anterior (0013: dono/equipe + seções).
 */

// modelo anterior (0013): seção liberada → regras equivalentes
const LEGACY: Record<string, RuleKey[]> = {
  painel: ['painel.ver'],
  caixa: ['caixa.vender', 'caixa.cancelar'],
  produtos: ['produtos.ver', 'produtos.editar', 'produtos.excluir'],
  pedidos: ['pedidos.ver', 'pedidos.status'],
  ofertas: ['ofertas.ver', 'ofertas.editar'],
  categorias: ['categorias.ver', 'categorias.editar'],
  conteudo: ['conteudo.ver', 'conteudo.editar'],
};

const OWNER = (roleId: string | null, roleName = 'Dono'): AdminAccess => ({ isOwner: true, roleId, roleName, rules: [...RULE_KEYS] });

export async function getAdminAccess(userId: string): Promise<AdminAccess | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  const { data: row, error } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    console.warn('[admin] getAdminAccess falhou:', error.message);
    return null;
  }
  if (!row) return null;

  if (row.role_id) {
    const { data: role, error: roleErr } = await sb
      .from('admin_roles')
      .select('id, name, is_owner, admin_role_permissions(admin_permissions(rules))')
      .eq('id', row.role_id)
      .maybeSingle();
    if (roleErr) {
      console.warn('[admin] cargo falhou:', roleErr.message);
      return null;
    }
    if (!role) return { isOwner: false, roleId: null, roleName: 'Sem cargo', rules: [] };
    if (role.is_owner) return OWNER(role.id, role.name);
    const rules = new Set<RuleKey>();
    for (const rp of (role.admin_role_permissions ?? []) as unknown as { admin_permissions: { rules: string[] } | null }[]) {
      for (const r of rp.admin_permissions?.rules ?? []) if (isRuleKey(r)) rules.add(r);
    }
    return { isOwner: false, roleId: role.id, roleName: role.name, rules: [...rules] };
  }

  // Depois da 0016 (coluna role_id existe), sem cargo = sem acesso. Os campos
  // antigos (role/permissions) NÃO valem mais: um ex-"dono" rebaixado cujo
  // cargo fosse excluído voltaria a ter acesso total.
  if (row.role_id === null) return { isOwner: false, roleId: null, roleName: 'Sem cargo', rules: [] };

  // antes da 0016 (sem a coluna role_id): modelo anterior (0013)
  if (row.role === 'equipe') {
    const legacy = (row.permissions ?? []) as string[];
    const rules = new Set<RuleKey>(['notificacoes.ver']);
    legacy.forEach((s) => LEGACY[s]?.forEach((r) => rules.add(r)));
    return { isOwner: false, roleId: null, roleName: 'Equipe', rules: [...rules] };
  }
  return OWNER(null); // 'dono' ou sem a coluna role (antes da 0013)
}

export async function isAdmin(userId: string): Promise<boolean> {
  return (await getAdminAccess(userId)) !== null;
}
