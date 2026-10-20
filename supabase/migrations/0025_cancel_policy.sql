-- =============================================================================
-- Política de cancelamento e devolução.
--  - delivered_at: quando o pedido virou Entregue (conta os 7 dias do CDC);
--  - return_requested_at / return_reason: o cliente pediu devolução;
--  - change_order_status: grava delivered_at e não tira ninguém de Cancelado.
-- Reexecutável. Rode no SQL Editor depois da 0024.
-- =============================================================================
alter table public.orders add column if not exists delivered_at        timestamptz;
alter table public.orders add column if not exists return_requested_at timestamptz;
alter table public.orders add column if not exists return_reason       text;

-- pedidos já entregues: a melhor data que temos é a última atualização
update public.orders set delivered_at = updated_at where status = 'delivered' and delivered_at is null;

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
  -- cancelado é final: nada volta (bloqueio de reversão)
  if v_order.status = 'cancelled' then
    raise exception 'Pedido cancelado não muda mais de status.';
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
        tracking_code = case when p_tracking is null then tracking_code else nullif(p_tracking, '') end,
        delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now())
                            else null end
    where id = v_order.id;

  return 'ok';
end;
$$;

revoke execute on function public.change_order_status(text, text, text) from public, anon, authenticated;
grant execute on function public.change_order_status(text, text, text) to service_role;
