-- =============================================================================
-- Meios de pagamento da loja (Mercado Pago) e histórico das tentativas.
--  - payment_settings: uma linha só (id = 1). Access Token e segredo do
--    webhook ficam CRIPTOGRAFADOS pelo servidor (AES-256-GCM, chave em
--    CREDENTIALS_KEY na Vercel); a Public Key é pública por natureza.
--  - payment_attempts: cada cobrança criada e cada aviso do webhook, para
--    conciliação. response_payload vai SEM dados pessoais do pagador (LGPD).
-- Sem policies: só o servidor (service role) lê e grava.
-- Reexecutável. Rode no SQL Editor depois da 0026.
-- =============================================================================
create table if not exists public.payment_settings (
  id                    int primary key default 1 check (id = 1),
  mp_access_token_enc   text,
  mp_public_key         text,
  mp_webhook_secret_enc text,
  updated_at            timestamptz not null default now(),
  updated_by            uuid
);
alter table public.payment_settings enable row level security;

create table if not exists public.payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  order_id            uuid references public.orders(id) on delete set null,
  order_number        text,
  channel             text check (channel in ('pos', 'ecommerce')),
  kind                text not null default 'charge', -- charge | webhook | refund
  provider_payment_id text,
  status              text not null,
  amount_cents        int,
  response_payload    jsonb
);
create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id, created_at desc);
create index if not exists payment_attempts_provider_idx on public.payment_attempts (provider_payment_id);
alter table public.payment_attempts enable row level security;
