-- =============================================================================
-- "Em separação" separado de "Pago" e pedido de cancelamento feito pelo cliente.
--  - paid       = pagamento confirmado;
--  - separating = a equipe começou a separar (escolhido no painel);
--  - cancel_requested_at / cancel_request_reason: o cliente pediu para
--    cancelar (só então a equipe pode cancelar uma compra online).
-- Reexecutável. Rode no SQL Editor depois da 0023.
-- =============================================================================
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending','paid','separating','failed','cancelled','shipped','delivered'));

alter table public.orders add column if not exists cancel_requested_at   timestamptz;
alter table public.orders add column if not exists cancel_request_reason text;

-- estoque: "Em separação" conta como pago (o estoque já saiu)
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

  v_was_paid := v_order.status in ('paid', 'separating', 'shipped', 'delivered');
  v_now_paid := p_status in ('paid', 'separating', 'shipped', 'delivered');

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
  if v_order.status in ('paid', 'separating', 'shipped', 'delivered') then
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
        payment_method = case when payment_method = 'misto' then 'misto' else p_method end,
        mp_payment_id = coalesce(p_payment_id, mp_payment_id)
    where id = v_order.id;

  return 'confirmed';
end;
$$;

revoke execute on function public.change_order_status(text, text, text) from public, anon, authenticated;
grant execute on function public.change_order_status(text, text, text) to service_role;
revoke execute on function public.confirm_order_payment(text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_order_payment(text, text, text) to service_role;
