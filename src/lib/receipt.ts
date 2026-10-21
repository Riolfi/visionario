import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';
import type { Order } from './types';

/**
 * Link do comprovante de uma venda: /comprovante/<id>.<validade>.<assinatura>.
 * A assinatura (HMAC com segredo do servidor) impede chegar ao comprovante de
 * outra pessoa trocando o número da venda; vale 90 dias a partir da venda.
 */
const VALID_MS = 90 * 24 * 60 * 60 * 1000;
const secret = () => `vz-recibo:${env.sessionSecret || env.supabaseServiceKey}`;
const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

export function receiptToken(order: Pick<Order, 'id' | 'created_at'>): string {
  const exp = Math.floor((new Date(order.created_at).getTime() + VALID_MS) / 1000).toString(36);
  return `${order.id}.${exp}.${sign(`${order.id}.${exp}`)}`;
}

export const receiptUrl = (order: Pick<Order, 'id' | 'created_at'>) => `${env.siteUrl}/comprovante/${receiptToken(order)}`;

/** id da venda, se a assinatura confere e o link não venceu; senão null. */
export function verifyReceiptToken(token: string): string | null {
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const want = Buffer.from(sign(`${id}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return parseInt(exp, 36) * 1000 >= Date.now() ? id : null;
}
