-- =============================================================================
-- Códigos por e-mail para mais de um uso: troca do Proprietário ('owner') e
-- troca do próprio e-mail ('email'). Reaproveita a tabela da 0019.
-- Reexecutável. Rode no SQL Editor depois da 0020.
-- =============================================================================
alter table public.owner_transfer_tokens add column if not exists purpose text not null default 'owner';
create index if not exists owner_transfer_tokens_user_purpose on public.owner_transfer_tokens (requested_by, purpose);
