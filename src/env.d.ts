/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly PUBLIC_SITE_URL: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly PUBLIC_MP_PUBLIC_KEY: string;
  readonly MP_ACCESS_TOKEN: string;
  readonly MP_WEBHOOK_SECRET: string;
  readonly RESEND_API_KEY: string;
  readonly RESEND_FROM: string;
  readonly PUBLIC_WHATSAPP_NUMBER: string;
  readonly PUBLIC_SHIPPING_FREE_THRESHOLD_CENTS: string;
  readonly PUBLIC_BRAND_NAME: string;
  readonly PUBLIC_BRAND_LEGAL_NAME: string;
  readonly PUBLIC_BRAND_CNPJ: string;
  readonly PUBLIC_QUIZ_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    user: import('@supabase/supabase-js').User | null;
    supabase: import('@supabase/supabase-js').SupabaseClient | null;
    site: import('./lib/types').SiteContent;
    brand: { name: string };
    accent: string | null;
    /** acesso à área administrativa (null = não é da equipe) */
    admin: import('./lib/repo/admin').AdminAccess | null;
  }
}
