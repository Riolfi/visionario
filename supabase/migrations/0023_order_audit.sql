-- =============================================================================
-- Pedido: quem vendeu no Caixa, quanto recebeu em dinheiro, e auditoria do
-- cancelamento (motivo, quem cancelou, quando).
-- Reexecutável. Rode no SQL Editor depois da 0022.
-- =============================================================================
alter table public.orders add column if not exists operator_id    uuid references auth.users(id) on delete set null;
alter table public.orders add column if not exists received_cents int;
alter table public.orders add column if not exists cancel_reason  text;
alter table public.orders add column if not exists cancelled_by   uuid references auth.users(id) on delete set null;
alter table public.orders add column if not exists cancelled_at   timestamptz;
