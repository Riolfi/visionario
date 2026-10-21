import type { APIRoute } from 'astro';
import { verifyMpCredentials } from '../../../../lib/mercadopago';
import { getMpCredentials } from '../../../../lib/repo/payment-settings';
import { isProprietor } from '../../../../lib/repo/owner';
import { json } from '../../../../lib/payment-service';

/**
 * POST /api/payments/config/verify — { access_token?, public_key }
 * Testa as chaves no Mercado Pago ANTES de salvar (nada é gravado aqui).
 * Token vazio = testa o token já salvo no painel com a Public Key informada.
 * Só o Proprietário.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user || !(await isProprietor(locals.user.email))) return json({ ok: false, error: 'Só o Proprietário configura os meios de pagamento.' }, 403);
  const body = (await request.json().catch(() => ({}))) as { access_token?: string; public_key?: string };
  const saved = await getMpCredentials();
  const token = String(body.access_token ?? '').trim() || (saved?.source === 'painel' ? saved.accessToken : '');
  const publicKey = String(body.public_key ?? '').trim();
  if (!token) return json({ ok: false, error: 'Informe o Access Token.' }, 400);
  if (!publicKey) return json({ ok: false, error: 'Informe a Public Key.' }, 400);
  const r = await verifyMpCredentials(token, publicKey);
  return json(r, r.ok ? 200 : 400);
};
