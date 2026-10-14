-- =============================================================================
-- Pagamento combinado no Caixa + aviso de estoque esgotado sempre.
-- Reexecutável. Rode no SQL Editor depois da 0016.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Formas de pagamento de uma venda combinada (ex.: dinheiro + cartão).
-- Lista de { method, amount_cents } — amount_cents do dinheiro é o valor
-- RECEBIDO (pode passar do restante: a diferença é o troco).
-- payment_method fica 'misto' nesses pedidos.
-- ----------------------------------------------------------------------------
alter table public.orders add column if not exists payments jsonb;

-- ----------------------------------------------------------------------------
-- Aviso de estoque: antes só saía se o produto ESTAVA ativo ao esgotar. Um
-- produto reabastecido sem marcar "Ativo" esgotava de novo em silêncio.
-- Agora avisa sempre que o estoque passa de >0 para 0.
-- ----------------------------------------------------------------------------
create or replace function public.products_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock <= 0 then
    if tg_op = 'UPDATE' and old.stock > 0 then
      insert into public.admin_notifications (kind, message, product_id)
      values (
        'estoque_esgotado',
        case when new.is_active
          then format('"%s" esgotou e foi desativado (sai da loja até repor o estoque).', new.name)
          else format('"%s" esgotou (já estava inativo).', new.name)
        end,
        new.id
      );
    end if;
    new.is_active := false;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Confirmação de pagamento: venda combinada (Pix + outra forma) continua
-- 'misto' quando o Pix confirma (antes viraria só 'pix').
-- Mesmo corpo da 0014; muda só o update do payment_method.
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
        payment_method = case when payment_method = 'misto' then 'misto' else p_method end,
        mp_payment_id = coalesce(p_payment_id, mp_payment_id)
    where id = v_order.id;

  return 'confirmed';
end;
$$;

-- create or replace mantém as permissões, mas reaplica a trava da 0015 por garantia
revoke execute on function public.confirm_order_payment(text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_order_payment(text, text, text) to service_role;
