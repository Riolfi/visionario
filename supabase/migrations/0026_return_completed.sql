-- =============================================================================
-- Devolução concluída: quando a loja recebeu o produto e estornou o valor.
-- O pedido vira Cancelado (o estoque volta pelo change_order_status).
-- Reexecutável. Rode no SQL Editor depois da 0025.
-- =============================================================================
alter table public.orders add column if not exists return_completed_at timestamptz;
