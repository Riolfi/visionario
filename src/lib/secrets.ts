import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env';

/**
 * Criptografia dos segredos guardados no banco (Access Token do Mercado Pago,
 * segredo do webhook): AES-256-GCM com a chave de CREDENTIALS_KEY (variável
 * da Vercel, qualquer texto longo — vira 32 bytes por SHA-256). Formato
 * gravado: "v1:<iv>:<tag>:<cifrado>" em base64. Sem a chave, nada é gravado.
 */
const keyFrom = () => {
  const raw = env.credentialsKey;
  return raw ? createHash('sha256').update(raw).digest() : null;
};

export const hasCredentialsKey = () => !!keyFrom();

export function encryptSecret(plain: string): string {
  const key = keyFrom();
  if (!key) throw new Error('CREDENTIALS_KEY não configurada.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** null se não houver chave, o texto estiver corrompido ou a chave mudou. */
export function decryptSecret(stored: string | null | undefined): string | null {
  const key = keyFrom();
  if (!key || !stored) return null;
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
