import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * Link "Criar senha" do e-mail de boas-vindas / senha redefinida:
 * /criar-senha?t=<e-mail>.<validade>.<assinatura>. Leva o e-mail já
 * preenchido (assinado: não dá para trocar) e vale 7 dias; quem entra ainda
 * precisa da senha temporária.
 */
const VALID_MS = 7 * 24 * 60 * 60 * 1000;
const sign = (data: string) => createHmac('sha256', `vz-senha:${env.sessionSecret || env.supabaseServiceKey}`).update(data).digest('base64url');

export function passwordSetupUrl(email: string): string {
  const e = Buffer.from(email.toLowerCase()).toString('base64url');
  const exp = Math.floor((Date.now() + VALID_MS) / 1000).toString(36);
  return `${env.siteUrl}/criar-senha?t=${e}.${exp}.${sign(`${e}.${exp}`)}`;
}

/** E-mail do link, se a assinatura confere e não venceu; senão null. */
export function verifyPasswordSetupToken(token: string): string | null {
  const [e, exp, sig] = token.split('.');
  if (!e || !exp || !sig) return null;
  const want = Buffer.from(sign(`${e}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (parseInt(exp, 36) * 1000 < Date.now()) return null;
  return Buffer.from(e, 'base64url').toString('utf8');
}
