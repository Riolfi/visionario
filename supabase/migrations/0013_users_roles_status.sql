-- =============================================================================
-- Usuários: papéis e permissões da equipe + estado da conta dos clientes.
-- Reexecutável. Rode no SQL Editor depois de 0012_admin_users.sql.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Equipe (admin_users): papel e permissões por seção do painel.
--   dono   → acesso total, inclusive gerenciar usuários
--   equipe → só as seções em `permissions`
-- Quem já era admin antes desta migration vira dono (ninguém perde acesso).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_users' and column_name = 'role'
  ) then
    alter table public.admin_users
      add column role text not null default 'equipe' check (role in ('dono', 'equipe')),
      add column permissions text[] not null default '{}';
    update public.admin_users set role = 'dono';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Estado da conta do cliente: ativo | desativado | bloqueado, com motivo.
-- Sem linha aqui = ativo. Sem policies de RLS: só o backend (service role) lê
-- e grava — o próprio cliente não consegue se desbloquear.
-- ----------------------------------------------------------------------------
create table if not exists public.customer_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  status     text not null default 'ativo' check (status in ('ativo', 'desativado', 'bloqueado')),
  reason     text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.customer_accounts enable row level security;

-- histórico de cada mudança de estado (quem, quando, por quê)
create table if not exists public.customer_status_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null check (status in ('ativo', 'desativado', 'bloqueado')),
  reason     text not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists customer_status_log_user_idx on public.customer_status_log(user_id, created_at desc);
alter table public.customer_status_log enable row level security;
