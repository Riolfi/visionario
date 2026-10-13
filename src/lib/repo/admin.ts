import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Acesso à área administrativa. Sempre reconsulta o banco — nunca confia em
 * nada vindo do cliente. `admin_users` não tem RLS policy, então só o client
 * service-role (usado aqui) a lê; promover alguém é ação do dono (tela de
 * Usuários) ou manual no banco, nunca de uma API pública.
 */

/** Seções do painel que podem ser liberadas para a equipe. */
export const ADMIN_SECTIONS = [
  { key: 'painel', label: 'Painel', href: '/admin' },
  { key: 'caixa', label: 'Caixa', href: '/admin/caixa' },
  { key: 'produtos', label: 'Produtos', href: '/admin/produtos' },
  { key: 'pedidos', label: 'Pedidos', href: '/admin/pedidos' },
  { key: 'ofertas', label: 'Ofertas', href: '/admin/ofertas' },
  { key: 'categorias', label: 'Categorias', href: '/admin/categorias' },
  { key: 'conteudo', label: 'Conteúdo', href: '/admin/site' },
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number]['key'];
export const SECTION_KEYS = ADMIN_SECTIONS.map((s) => s.key) as AdminSection[];

export type AdminRole = 'dono' | 'equipe';
export interface AdminAccess {
  role: AdminRole;
  /** seções liberadas (o dono tem todas) */
  permissions: AdminSection[];
}

export async function getAdminAccess(userId: string): Promise<AdminAccess | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  // select('*'): funciona antes e depois da migration 0013 (role/permissions)
  const { data, error } = await sb.from('admin_users').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    console.warn('[admin] getAdminAccess falhou:', error.message);
    return null;
  }
  if (!data) return null;
  // sem a coluna role (migration 0013 ainda não rodou) = admin antigo = dono
  const role: AdminRole = data.role === 'equipe' ? 'equipe' : 'dono';
  const perms = Array.isArray(data.permissions) ? data.permissions : [];
  return {
    role,
    permissions: role === 'dono' ? [...SECTION_KEYS] : SECTION_KEYS.filter((k) => perms.includes(k)),
  };
}

export async function isAdmin(userId: string): Promise<boolean> {
  return (await getAdminAccess(userId)) !== null;
}

/**
 * Pode abrir essa rota? Mapeia páginas e APIs do painel para a seção.
 * Rota desconhecida em /admin fica só para o dono (padrão seguro).
 */
export function canAccess(access: AdminAccess, pathname: string): boolean {
  if (access.role === 'dono') return true;
  const has = (...keys: AdminSection[]) => keys.some((k) => access.permissions.includes(k));
  const under = (...prefixes: string[]) => prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (under('/admin/perfil', '/api/admin/profile')) return true; // o próprio perfil
  if (under('/admin/usuarios', '/api/admin/users', '/api/admin/customers')) return false; // só dono
  if (pathname === '/admin' || pathname === '/admin/') return has('painel');
  if (under('/admin/caixa', '/api/admin/caixa')) return has('caixa');
  // a Caixa também procura produto pelo código
  if (under('/api/admin/products/by-barcode')) return has('caixa', 'produtos');
  if (under('/admin/produtos', '/api/admin/products')) return has('produtos');
  if (under('/admin/pedidos', '/api/admin/orders')) return has('pedidos');
  if (under('/admin/ofertas', '/api/admin/offers')) return has('ofertas');
  if (under('/admin/categorias', '/api/admin/categories')) return has('categorias');
  if (under('/admin/site', '/api/admin/site')) return has('conteudo');
  // upload de imagem serve produtos, ofertas e conteúdo (logo)
  if (under('/api/admin/upload')) return has('produtos', 'ofertas', 'conteudo');
  return false;
}

/** Primeira tela que essa pessoa pode abrir (destino depois do login / sem permissão). */
export function homeFor(access: AdminAccess): string {
  return ADMIN_SECTIONS.find((s) => access.permissions.includes(s.key))?.href ?? '/admin/perfil';
}
