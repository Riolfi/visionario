import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Limite da sessão de login: sai depois de 2 h sem uso ou 4 h no total.
 * O Supabase (plano grátis) mantém o login por ~400 dias; aqui o servidor
 * guarda, num cookie httpOnly, o id da sessão, o início e o último acesso.
 * Sessão nova (outro login) zera a contagem sozinha: o id muda.
 */
export const IDLE_MS = 2 * 60 * 60 * 1000;
export const MAX_MS = 4 * 60 * 60 * 1000;
const NAME = 'vz-sess';
const SECURE = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: env.siteUrl.startsWith('https://') };

/** id da sessão no token (o token já foi conferido pelo getUser). */
function sessionId(accessToken: string | undefined): string {
  try {
    const payload = JSON.parse(atob((accessToken ?? '').split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return String(payload.session_id ?? '');
  } catch {
    return '';
  }
}

/** Confere os limites; true = a sessão venceu (quem chama faz o signOut). */
export async function sessionExpired(supabase: SupabaseClient, cookies: AstroCookies, now = Date.now()): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const sid = sessionId(data.session?.access_token);
  let cur: { sid: string; start: number; seen: number } | null = null;
  try {
    cur = JSON.parse(cookies.get(NAME)?.value ?? 'null');
  } catch {
    /* cookie estragado: começa de novo */
  }
  if (cur && cur.sid === sid && (now - cur.seen > IDLE_MS || now - cur.start > MAX_MS)) {
    cookies.delete(NAME, { path: '/' });
    return true;
  }
  const start = cur && cur.sid === sid ? cur.start : now;
  cookies.set(NAME, JSON.stringify({ sid, start, seen: now }), { ...SECURE, maxAge: MAX_MS / 1000 });
  return false;
}

export const clearSessionLimits = (cookies: AstroCookies) => cookies.delete(NAME, { path: '/' });
