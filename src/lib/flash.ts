import type { AstroCookies } from 'astro';

/**
 * Aviso de uma página só (sucesso/erro depois de um formulário). Vai num
 * cookie curto em vez da URL — ninguém consegue montar um link com mensagem
 * falsa — e é apagado ao ser lido.
 */
export type Flash = { type: 'ok' | 'erro'; text: string };
const NAME = 'flash';

export function setFlash(cookies: AstroCookies, type: Flash['type'], text: string) {
  cookies.set(NAME, JSON.stringify({ type, text }), { path: '/admin', httpOnly: true, sameSite: 'lax', maxAge: 60 });
}

export function takeFlash(cookies: AstroCookies): Flash | null {
  const raw = cookies.get(NAME)?.value;
  if (!raw) return null;
  cookies.delete(NAME, { path: '/admin' });
  try {
    const f = JSON.parse(raw);
    return (f.type === 'ok' || f.type === 'erro') && typeof f.text === 'string' ? f : null;
  } catch {
    return null;
  }
}
