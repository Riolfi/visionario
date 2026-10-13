-- =============================================================================
-- Segurança: as funções que mexem em pedidos e estoque rodam com permissão
-- total (security definer) e, por padrão, o Supabase deixa qualquer função do
-- schema public ser chamada pela API com a chave pública (anon) ou por
-- qualquer usuário logado. Ou seja: dava para confirmar pagamento, cancelar
-- venda ou baixar estoque direto pela API. Aqui só o backend (service_role)
-- continua podendo chamá-las. Reexecutável; ignora as que ainda não existem.
-- =============================================================================
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.confirm_order_payment(text, text, text)',
    'public.caixa_checkout(text, text, jsonb)',
    'public.cancel_caixa_sale(text)',
    'public.change_order_status(text, text, text)'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
