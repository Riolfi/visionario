import type { APIRoute } from 'astro';
import { verifyMpCredentials } from '../../../lib/mercadopago';
import { clearMpSettings, getMpCredentials, saveMpSettings } from '../../../lib/repo/payment-settings';
import { hasCredentialsKey } from '../../../lib/secrets';
import { isProprietor } from '../../../lib/repo/owner';
import { passwordMatches } from '../../../lib/password-check';
import { json } from '../../../lib/payment-service';

/**
 * POST /api/admin/payment-settings — Configurações › Meios de pagamento.
 *   acao=salvar   { access_token?, public_key, webhook_secret?, senha_atual }
 *                 testa no Mercado Pago de novo e só então grava (token e
 *                 segredo criptografados); campo vazio mantém o salvo
 *   acao=remover  { senha_atual } apaga as chaves do painel
 * Só o Proprietário, sempre com a senha atual.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user || !(await isProprietor(user.email))) return json({ ok: false, error: 'Só o Proprietário altera os meios de pagamento.' }, 403);
  const body = (await request.json().catch(() => ({}))) as Record<string, string | undefined>;
  if (!(await passwordMatches(user.email ?? '', String(body.senha_atual ?? '')))) return json({ ok: false, error: 'Senha atual incorreta.' }, 400);

  if (body.acao === 'remover') {
    await clearMpSettings();
    return json({ ok: true });
  }

  if (!hasCredentialsKey()) {
    return json({ ok: false, error: 'Falta a variável CREDENTIALS_KEY na Vercel para guardar o token com segurança. Configure-a e faça um novo deploy.' }, 400);
  }
  const accessToken = String(body.access_token ?? '').trim();
  const publicKey = String(body.public_key ?? '').trim();
  const webhookSecret = String(body.webhook_secret ?? '').trim();
  // vazio = mantém o token já salvo no painel (o das variáveis da Vercel não conta)
  const saved = await getMpCredentials();
  const token = accessToken || (saved?.source === 'painel' ? saved.accessToken : '');
  if (!token) return json({ ok: false, error: 'Informe o Access Token.' }, 400);
  if (!publicKey) return json({ ok: false, error: 'Informe a Public Key.' }, 400);
  const check = await verifyMpCredentials(token, publicKey);
  if (!check.ok) return json(check, 400);
  // token só vai ao banco se foi digitado agora (vazio = mantém o salvo)
  const stored = await saveMpSettings({ accessToken: accessToken || undefined, publicKey, webhookSecret: webhookSecret || undefined }, user.id);
  if (!stored.ok) return json(stored, 500);
  return json({ ok: true, environment: check.environment, account: check.account });
};
