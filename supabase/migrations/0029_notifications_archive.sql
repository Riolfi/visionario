-- =============================================================================
-- Notificações: arquivar (sai da caixa de entrada, fica no histórico) e
-- excluir com "desfazer" (exclusão lógica: deleted_at preenchido some da tela).
-- Arquivadas e excluídas não contam no sino.
-- Reexecutável. Rode no SQL Editor depois da 0028.
-- =============================================================================
alter table public.admin_notifications add column if not exists archived_at timestamptz;
alter table public.admin_notifications add column if not exists deleted_at  timestamptz;
create index if not exists admin_notifications_inbox_idx
  on public.admin_notifications (created_at desc) where deleted_at is null;
