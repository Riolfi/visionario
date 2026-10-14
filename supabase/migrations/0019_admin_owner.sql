-- =============================================================================
-- Cargo "Dono" vira "Administrador"; cargo ativo/inativo; Proprietário da
-- conta (e-mail do responsável legal) com troca confirmada por código.
-- Reexecutável. Rode no SQL Editor depois da 0018.
-- =============================================================================

-- cargo inativo: quem tem fica sem acesso a nenhuma tela (o Administrador não desativa)
alter table public.admin_roles add column if not exists is_active boolean not null default true;

-- e-mail do Proprietário: só no cargo Administrador (is_owner)
alter table public.admin_roles add column if not exists owner_email text;

update public.admin_roles set name = 'Administrador' where is_owner and name = 'Dono';

-- Proprietário inicial: a conta mais antiga com o cargo Administrador
update public.admin_roles r
  set owner_email = (
    select lower(u.email)
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    where a.role_id = r.id
    order by u.created_at
    limit 1
  )
  where r.is_owner and r.owner_email is null;

-- Códigos de troca do Proprietário (6 dígitos, 15 min). Guarda só o hash.
create table if not exists public.owner_transfer_tokens (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  new_email    text not null,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  created_at   timestamptz not null default now()
);
-- sem policies: só o servidor (service role) lê e grava
alter table public.owner_transfer_tokens enable row level security;
