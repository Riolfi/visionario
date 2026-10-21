-- =============================================================================
-- Cancelamento com análise e decisão de estoque.
--  - pedido de cancelamento do cliente (cancel_requested_at, da 0024) agora
--    é analisado: aprovado (vira Cancelado) ou recusado com resposta;
--  - stock_resolution: por item, quantas unidades voltaram ao estoque e
--    quantas viraram perda (avaria); stock_pending = itens fora do estoque
--    esperando a decisão (ex.: aguardando o cliente devolver).
-- Reexecutável. Rode no SQL Editor depois da 0027.
-- =============================================================================
alter table public.orders add column if not exists cancel_request_response    text;
alter table public.orders add column if not exists cancel_request_resolved_at timestamptz;
alter table public.orders add column if not exists cancel_request_resolved_by uuid;
alter table public.orders add column if not exists stock_resolution  jsonb;
alter table public.orders add column if not exists stock_pending     boolean not null default false;
alter table public.orders add column if not exists stock_resolved_at timestamptz;
alter table public.orders add column if not exists stock_resolved_by uuid;
