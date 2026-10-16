-- =============================================================================
-- Último acesso ao painel (para "Online/Offline" na lista de Usuários).
-- Gravado pelo servidor no máximo a cada 2 minutos por pessoa.
-- Reexecutável. Rode no SQL Editor depois da 0021.
-- =============================================================================
alter table public.admin_users add column if not exists last_seen_at timestamptz;
