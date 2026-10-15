import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Limite da sessão de login: sai depois de 2 h sem uso ou 4 h no total.
 * O Supabase (plano grátis) mantém o login por ~400 dias, então o servidor
 * confere aqui:
 *  - 4 h no total: pela hora do login gravada no token (claim `amr`), que o
 *    Supabase assina e o getUser já conferiu — o navegador não muda;
 *  - 2 h sem uso: pelo último acesso num cookie httpOnly ASSINADO (HMAC com
 *    segredo do servidor). Cookie ausente, adulterado ou de outra sessão numa
 *    sessão com mais de 2 h conta como vencido (falha fechada).
 */
export const IDLE_MS = 2 * 60 * 60 * 1000;
export const MAX_MS = 4 * 60 * 60 * 1000;
const NAME = 'vz-sess';
const OPTS = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: env.siteUrl.startsWith('https://') };

interface Claims {
  sid: string;
  /** hora do login (ms), do `amr` do token */
  authAt: number | null;
}

/** Lê o token (já conferido pelo getUser no middleware). */
function claims(accessToken: string | undefined): Claims {
  try {
    const p = JSON.parse(atob((accessToken ?? '').split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    const times = (Array.isArray(p.amr) ? p.amr : []).map((a: { timestamp?: number }) => Number(a.timestamp)).filter((t: number) => t > 0);
    return { sid: String(p.session_id ?? ''), authAt: times.length ? Math.min(...times) * 1000 : null };
  } catch {
    return { sid: '', authAt: null };
  }
}

async function hmac(data: string): Promise<string> {
  const secret = env.sessionSecret || env.supabaseServiceKey;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`vz-sess:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cookie `sid.seen.assinatura`; null se faltar ou não bater a assinatura. */
async function readSeen(cookies: AstroCookies, sid: string): Promise<number | null> {
  const [csid, seen, sig] = (cookies.get(NAME)?.value ?? '').split('.');
  if (!csid || !seen || !sig || csid !== sid) return null;
  return (await hmac(`${csid}.${seen}`)) === sig ? Number(seen) : null;
}

/** Confere os limites; true = a sessão venceu (quem chama faz o signOut). */
export async function sessionExpired(supabase: SupabaseClient, cookies: AstroCookies, now = Date.now()): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const { sid, authAt } = claims(data.session?.access_token);
  const expire = () => (cookies.delete(NAME, { path: '/' }), true);

  if (authAt !== null && now - authAt > MAX_MS) return expire();
  // sem a hora do login no token (não deveria acontecer): usa a do cookie, como antes
  const seen = await readSeen(cookies, sid);
  if (seen !== null && now - seen > IDLE_MS) return expire();
  // sem cookie válido: só aceita como "acabou de entrar" se o login tem menos de 2 h
  if (seen === null && authAt !== null && now - authAt > IDLE_MS) return expire();

  cookies.set(NAME, `${sid}.${now}.${await hmac(`${sid}.${now}`)}`, { ...OPTS, maxAge: MAX_MS / 1000 });
  return false;
}

export const clearSessionLimits = (cookies: AstroCookies) => cookies.delete(NAME, { path: '/' });
