-- =============================================================================
-- Troca ou devolução em duas etapas.
--  - return_kind: o que o cliente pediu ('devolucao' = reembolso; 'troca');
--  - etapa 1: a equipe aprova e informa como devolver (Correios + código de
--    postagem reversa) ou recusa com resposta;
--  - etapa 2: com os itens na loja, conclui com reembolso integral (produtos +
--    frete; o pedido vira Cancelado) ou troca (cria um pedido de reenvio de
--    R$ 0 ligado ao original: exchange_of / exchange_order_number).
-- Reexecutável. Rode no SQL Editor depois da 0029.
-- =============================================================================
alter table public.orders add column if not exists return_kind           text;
alter table public.orders add column if not exists return_approved_at    timestamptz;
alter table public.orders add column if not exists return_approved_by    uuid;
alter table public.orders add column if not exists return_post_code      text;
alter table public.orders add column if not exists return_instructions   text;
alter table public.orders add column if not exists return_rejected_at    timestamptz;
alter table public.orders add column if not exists return_response       text;
alter table public.orders add column if not exists return_resolution     text;
alter table public.orders add column if not exists return_completed_by   uuid;
alter table public.orders add column if not exists exchange_of           text;
alter table public.orders add column if not exists exchange_order_number text;

alter table public.orders drop constraint if exists orders_return_kind_check;
alter table public.orders add constraint orders_return_kind_check check (return_kind is null or return_kind in ('devolucao', 'troca'));
alter table public.orders drop constraint if exists orders_return_resolution_check;
alter table public.orders add constraint orders_return_resolution_check check (return_resolution is null or return_resolution in ('reembolso', 'troca'));
