-- =============================================================================
-- Permissão ativa/inativa. Inativa não dá nenhuma regra a quem tem o cargo,
-- mas continua ligada aos cargos (reativar devolve o acesso).
-- Reexecutável. Rode no SQL Editor depois da 0017.
-- =============================================================================
alter table public.admin_permissions add column if not exists is_active boolean not null default true;
