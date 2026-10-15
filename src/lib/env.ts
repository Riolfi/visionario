/**
 * Leitura centralizada de variáveis de ambiente (server-side).
 * Usa import.meta.env (injetado pelo Vite/Astro) com fallback para process.env
 * (útil em runtimes serverless e scripts).
 */

function read(key: string): string {
  const fromVite = (import.meta.env as Record<string, string | undefined>)[key];
  if (fromVite != null && fromVite !== '') return fromVite;
  const fromNode = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return fromNode ?? '';
}

export const env = {
  /** SITE_URL (ou PUBLIC_SITE_URL); sem nenhuma, usa o domínio de produção que a Vercel expõe. */
  siteUrl:
    read('SITE_URL') ||
    read('PUBLIC_SITE_URL') ||
    (read('VERCEL_PROJECT_PRODUCTION_URL') && `https://${read('VERCEL_PROJECT_PRODUCTION_URL')}`) ||
    'http://localhost:4321',

  /** Nome da marca — usado em títulos, e-mails, fatura do cartão, JSON-LD. */
  brandName: read('PUBLIC_BRAND_NAME') || 'Visionário',
  /** Razão social + CNPJ para páginas legais e descrição de cobrança. */
  brandLegalName: read('PUBLIC_BRAND_LEGAL_NAME') || 'Visionário Acessórios LTDA',
  brandCnpj: read('PUBLIC_BRAND_CNPJ') || '00.000.000/0001-00',

  /** Token da API Cosmos (Bluesoft) — busca de produto por código de barras no
   *  cadastro. Opcional: sem ele, a busca usa só as bases Open Facts. */
  cosmosToken: read('COSMOS_TOKEN'),

  supabaseUrl: read('SUPABASE_URL'),
  supabaseAnonKey: read('SUPABASE_ANON_KEY'),
  supabaseServiceKey: read('SUPABASE_SERVICE_ROLE_KEY'),
  /** assina o cookie de inatividade (sem ele, usa um derivado da service role) */
  sessionSecret: read('SESSION_SECRET'),

  mpPublicKey: read('PUBLIC_MP_PUBLIC_KEY'),
  mpAccessToken: read('MP_ACCESS_TOKEN'),
  mpWebhookSecret: read('MP_WEBHOOK_SECRET'),

  resendApiKey: read('RESEND_API_KEY'),
  resendFrom:
    read('RESEND_FROM') ||
    `${read('PUBLIC_BRAND_NAME') || 'Visionário'} <onboarding@resend.dev>`,

  whatsappNumber: read('PUBLIC_WHATSAPP_NUMBER') || '5511999999999',
  shippingFreeThresholdCents: Number(read('PUBLIC_SHIPPING_FREE_THRESHOLD_CENTS') || '19900'),
};

export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseServiceKey);
export const hasSupabasePublic = Boolean(env.supabaseUrl && env.supabaseAnonKey);
export const hasMercadoPago = Boolean(env.mpAccessToken && env.mpPublicKey);
export const hasResend = Boolean(env.resendApiKey);
