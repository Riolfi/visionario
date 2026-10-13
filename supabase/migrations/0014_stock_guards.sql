-- =============================================================================
-- Estoque: correções de baixa/devolução, produto esgotado sai da loja sozinho
-- e notificações da área administrativa. Reexecutável. Rode no SQL Editor.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Notificações do painel (ex.: "produto desativado por falta de estoque").
-- Sem policies: só o backend (service role) lê e grava.
-- ----------------------------------------------------------------------------
create table if not exists public.admin_notifications (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  message    text not null,
  product_id uuid references public.products(id) on delete set null,
  order_number text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists admin_notifications_unread_idx on public.admin_notifications(created_at desc) where read_at is null;
alter table public.admin_notifications enable row level security;

-- ----------------------------------------------------------------------------
-- Produto com estoque 0 nunca fica ativo. Vale para qualquer caminho: venda no
-- Caixa, venda online, edição manual ou SQL. Ao desativar um produto que
-- estava ativo, registra a notificação.
-- ----------------------------------------------------------------------------
create or replace function public.products_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock <= 0 and new.is_active then
    new.is_active := false;
    if tg_op = 'UPDATE' and old.is_active then
      insert into public.admin_notifications (kind, message, product_id)
      values ('estoque_esgotado', format('"%s" foi desativado por falta de estoque.', new.name), new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_stock_guard on public.products;
create trigger products_stock_guard
  before insert or update of stock, is_active on public.products
  for each row execute function public.products_stock_guard();

-- produtos que já estão zerados e ativos hoje saem da loja agora
update public.products set is_active = false where stock <= 0 and is_active;

-- ----------------------------------------------------------------------------
-- Confirmação de pagamento: idempotente também para pedido já enviado ou
-- entregue (antes, um webhook repetido baixava o estoque de novo e voltava o
-- status para "pago"); pedido cancelado não baixa estoque (ex.: Pix do Caixa
-- que o operador desistiu e cobrou de outro jeito — o pagamento tardio precisa
-- ser estornado, não vendido de novo).
-- ----------------------------------------------------------------------------
create or replace function public.confirm_order_payment(
  p_order_number text,
  p_payment_id   text,
  p_method       text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_item    record;
  v_updated int;
begin
  select * into v_order from public.orders
    where order_number = p_order_number
    for update;

  if not found then
    return 'not_found';
  end if;
  if v_order.status in ('paid', 'shipped', 'delivered') then
    return 'already_paid';
  end if;
  if v_order.status = 'cancelled' then
    insert into public.admin_notifications (kind, message, order_number)
    values ('pagamento_pedido_cancelado',
            format('O pedido #%s foi pago, mas estava cancelado. Confira e estorne o pagamento se for o caso.', p_order_number),
            p_order_number);
    return 'cancelled';
  end if;

  for v_item in
    select product_id, quantity from public.order_items where order_id = v_order.id
  loop
    update public.products
      set stock = stock - v_item.quantity
      where id = v_item.product_id and stock >= v_item.quantity;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'Estoque insuficiente para o produto % no pedido %',
        v_item.product_id, p_order_number;
    end if;
  end loop;

  update public.orders
    set status = 'paid',
        payment_method = p_method,
        mp_payment_id = coalesce(p_payment_id, mp_payment_id)
    where id = v_order.id;

  return 'confirmed';
end;
$$;

-- ----------------------------------------------------------------------------
-- Cancelar venda do Caixa: só devolve estoque se a venda tinha baixado (paga).
-- Antes, cancelar um Pix que nunca foi pago criava estoque do nada.
-- ----------------------------------------------------------------------------
create or replace function public.cancel_caixa_sale(
  p_order_number text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line  record;
begin
  select * into v_order from public.orders
    where order_number = p_order_number
    for update;

  if not found then
    return 'not_found';
  end if;
  if v_order.source <> 'caixa' then
    return 'not_caixa';
  end if;
  if v_order.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_order.status in ('paid', 'shipped', 'delivered') then
    for v_line in
      select product_id, quantity from public.order_items where order_id = v_order.id
    loop
      update public.products
        set stock = stock + v_line.quantity
        where id = v_line.product_id;
    end loop;
  end if;

  update public.orders
    set status = 'cancelled'
    where id = v_order.id;

  return 'cancelled';
end;
$$;

-- ----------------------------------------------------------------------------
-- Mudança de status pelo painel (Pedidos) acompanhando o estoque, numa
-- transação: sair de pago/enviado/entregue para cancelado/falhou/aguardando
-- devolve os itens; entrar em pago/enviado/entregue vindo de não pago baixa
-- (e recusa se faltar estoque).
-- ----------------------------------------------------------------------------
create or replace function public.change_order_status(
  p_order_number text,
  p_status       text,
  p_tracking     text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order    public.orders%rowtype;
  v_line     record;
  v_updated  int;
  v_was_paid boolean;
  v_now_paid boolean;
begin
  select * into v_order from public.orders
    where order_number = p_order_number
    for update;
  if not found then
    return 'not_found';
  end if;

  v_was_paid := v_order.status in ('paid', 'shipped', 'delivered');
  v_now_paid := p_status in ('paid', 'shipped', 'delivered');

  if v_was_paid and not v_now_paid then
    for v_line in select product_id, quantity from public.order_items where order_id = v_order.id loop
      update public.products set stock = stock + v_line.quantity where id = v_line.product_id;
    end loop;
  elsif v_now_paid and not v_was_paid then
    for v_line in select oi.product_id, oi.quantity, oi.product_name from public.order_items oi where oi.order_id = v_order.id loop
      update public.products
        set stock = stock - v_line.quantity
        where id = v_line.product_id and stock >= v_line.quantity;
      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'Estoque insuficiente para "%".', v_line.product_name;
      end if;
    end loop;
  end if;

  update public.orders
    set status = p_status,
        tracking_code = case when p_tracking is null then tracking_code else nullif(p_tracking, '') end
    where id = v_order.id;

  return 'ok';
end;
$$;
