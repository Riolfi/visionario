import { env, hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { decryptSecret, encryptSecret } from '../secrets';

/**
 * Credenciais do Mercado Pago da loja: as salvas em Configurações › Meios de
 * pagamento (banco, token criptografado) valem primeiro; sem elas, as
 * variáveis da Vercel (MP_ACCESS_TOKEN, PUBLIC_MP_PUBLIC_KEY, MP_WEBHOOK_SECRET).
 * Sem nenhuma, o sistema roda em modo simulado.
 */
export type MpEnvironment = 'test' | 'production';
export interface MpCredentials {
  accessToken: string;
  publicKey: string;
  webhookSecret: string;
  source: 'painel' | 'variaveis';
  environment: MpEnvironment;
}

/** O ambiente vem da própria credencial: TEST-… é teste, APP_USR-… é produção. */
export const environmentOf = (key: string): MpEnvironment | null =>
  key.startsWith('TEST-') ? 'test' : key.startsWith('APP_USR-') ? 'production' : null;

/** "APP_USR-…a1b2": o suficiente para reconhecer, sem mostrar o segredo. */
export const maskKey = (key: string) => (key ? `${key.split('-')[0]}-…${key.slice(-4)}` : '');

interface Row {
  mp_access_token_enc: string | null;
  mp_public_key: string | null;
  mp_webhook_secret_enc: string | null;
  updated_at: string;
}

async function readRow(): Promise<Row | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  const { data, error } = await sb.from('payment_settings').select('*').eq('id', 1).maybeSingle();
  return error ? null : (data as Row | null); // sem a 0027: segue com as variáveis
}

export async function getMpCredentials(): Promise<MpCredentials | null> {
  const row = await readRow();
  const token = decryptSecret(row?.mp_access_token_enc);
  if (token && row?.mp_public_key) {
    return {
      accessToken: token,
      publicKey: row.mp_public_key,
      webhookSecret: decryptSecret(row.mp_webhook_secret_enc) ?? '',
      source: 'painel',
      environment: environmentOf(token) ?? 'production',
    };
  }
  if (env.mpAccessToken && env.mpPublicKey) {
    return {
      accessToken: env.mpAccessToken,
      publicKey: env.mpPublicKey,
      webhookSecret: env.mpWebhookSecret,
      source: 'variaveis',
      environment: environmentOf(env.mpAccessToken) ?? 'production',
    };
  }
  return null;
}

/** O que a tela mostra: nunca o token em si. */
export async function getMpSettingsView() {
  const row = await readRow();
  const creds = await getMpCredentials();
  return {
    configured: !!creds,
    source: creds?.source ?? null,
    environment: creds?.environment ?? null,
    accessTokenMasked: creds ? maskKey(creds.accessToken) : '',
    publicKey: creds?.publicKey ?? '',
    hasWebhookSecret: !!creds?.webhookSecret,
    updatedAt: row?.updated_at ?? null,
    // token salvo, mas não dá para ler (CREDENTIALS_KEY trocada ou ausente)
    unreadable: !!row?.mp_access_token_enc && !decryptSecret(row.mp_access_token_enc),
  };
}

export async function saveMpSettings(
  input: { accessToken?: string; publicKey: string; webhookSecret?: string },
  by: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, error: 'Supabase não configurado.' };
  const patch: Record<string, unknown> = { id: 1, mp_public_key: input.publicKey, updated_at: new Date().toISOString(), updated_by: by };
  // campo vazio = mantém o que já está salvo
  if (input.accessToken) patch.mp_access_token_enc = encryptSecret(input.accessToken);
  if (input.webhookSecret) patch.mp_webhook_secret_enc = encryptSecret(input.webhookSecret);
  const { error } = await sb.from('payment_settings').upsert(patch, { onConflict: 'id' });
  return error ? { ok: false, error: /payment_settings/.test(error.message) ? 'Rode a migration 0027 no Supabase.' : error.message } : { ok: true };
}

/** Apaga as chaves do painel (volta às variáveis da Vercel ou ao modo simulado). */
export async function clearMpSettings(): Promise<void> {
  await supabaseAdmin()?.from('payment_settings').delete().eq('id', 1);
}
