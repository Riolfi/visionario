-- =============================================================================
-- Visionário — TODAS as migrations num arquivo só. Reexecutável (idempotente).
-- Cole no SQL Editor do Supabase. Depois: `npm run seed`.
-- Gerado de supabase/migrations/. Ordem importa.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0001_init.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — schema inicial
-- Rode no SQL Editor do Supabase (ou via `supabase db push`).
-- =============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Tabelas
-- ----------------------------------------------------------------------------

create table if not exists public.categories (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text not null default '',
  position     int  not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.products (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique,
  name                   text not null,
  category_id            uuid not null references public.categories(id) on delete restrict,
  short_description      text not null default '',
  description            text not null default '',
  ingredients            text not null default '',
  how_to_use             text not null default '',
  price_cents            int  not null check (price_cents >= 0),
  compare_at_price_cents int  check (compare_at_price_cents is null or compare_at_price_cents >= 0),
  stock                  int  not null default 0 check (stock >= 0),
  is_active              boolean not null default true,
  is_bestseller          boolean not null default false,
  rating                 numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  reviews_count          int not null default 0,
  images                 jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_active_idx   on public.products(is_active);

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique,
  status            text not null default 'pending'
                      check (status in ('pending','paid','failed','cancelled')),
  customer_name     text not null,
  customer_email    text not null,
  customer_phone    text not null default '',
  customer_cpf      text not null default '',
  shipping_cep      text not null default '',
  shipping_address  jsonb not null default '{}'::jsonb,
  shipping_cents    int not null default 0 check (shipping_cents >= 0),
  subtotal_cents    int not null check (subtotal_cents >= 0),
  total_cents       int not null check (total_cents >= 0),
  payment_method    text,
  mp_payment_id     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_status_idx  on public.orders(status);
create index if not exists orders_created_idx on public.orders(created_at desc);

create table if not exists public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  product_id       uuid not null references public.products(id) on delete restrict,
  product_name     text not null,
  product_slug     text,
  unit_price_cents int not null check (unit_price_cents >= 0),
  quantity         int not null check (quantity > 0)
);

create index if not exists order_items_order_idx on public.order_items(order_id);

-- ----------------------------------------------------------------------------
-- updated_at automático
-- ----------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- RPC: confirmar pagamento + decrementar estoque (atômico e idempotente)
-- Executa com privilégios do dono (security definer) e é chamada só pelo
-- backend com a service-role key.
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

  -- idempotência: se já está pago, não faz nada
  if v_order.status = 'paid' then
    return 'already_paid';
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
-- Row Level Security
-- ----------------------------------------------------------------------------

alter table public.categories  enable row level security;
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

-- Catálogo: leitura pública
drop policy if exists "categories readable" on public.categories;
create policy "categories readable" on public.categories
  for select using (true);

drop policy if exists "active products readable" on public.products;
create policy "active products readable" on public.products
  for select using (is_active = true);

-- orders / order_items: nenhuma política para anon/authenticated =>
-- acesso somente via service-role key (que ignora RLS) no backend.


-- ─────────────────────────────────────────────────────────────────────────────
-- 0002_accounts.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — contas de cliente (Supabase Auth)
-- Rode DEPOIS de 0001_init.sql. Habilite os providers Email e Google no painel:
-- Authentication > Providers.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- profiles — dados do cliente (1:1 com auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null default '',
  phone      text not null default '',
  cpf        text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- cria o profile automaticamente quando um usuário se cadastra
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists "own profile - select" on public.profiles;
create policy "own profile - select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own profile - insert" on public.profiles;
create policy "own profile - insert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "own profile - update" on public.profiles;
create policy "own profile - update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ----------------------------------------------------------------------------
-- addresses — endereços salvos
-- ----------------------------------------------------------------------------
create table if not exists public.addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null default 'Endereço',
  cep         text not null,
  street      text not null,
  number      text not null,
  complement  text not null default '',
  district    text not null default '',
  city        text not null,
  state       text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists addresses_user_idx on public.addresses(user_id);

alter table public.addresses enable row level security;

drop policy if exists "own addresses" on public.addresses;
create policy "own addresses" on public.addresses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- orders.user_id — vincula pedidos à conta (null = pedido de convidado)
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists orders_user_idx on public.orders(user_id);

-- cliente logado enxerga os próprios pedidos (escrita continua só via service-role)
drop policy if exists "own orders - select" on public.orders;
create policy "own orders - select" on public.orders
  for select using (auth.uid() = user_id);

drop policy if exists "own order items - select" on public.order_items;
create policy "own order items - select" on public.order_items
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id and o.user_id = auth.uid()
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- 0003_order_status.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — status de envio do pedido + código de rastreio
-- Rode DEPOIS de 0002_accounts.sql.
-- =============================================================================

alter table public.orders
  add column if not exists tracking_code text;

alter table public.orders
  drop constraint if exists orders_status_check;

alter table public.orders
  add constraint orders_status_check
  check (status in ('pending','paid','failed','cancelled','shipped','delivered'));


-- ─────────────────────────────────────────────────────────────────────────────
-- 0004_quiz.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — quiz de pele / rotina personalizada
-- Rode DEPOIS de 0003_order_status.sql. Depois rode `npm run seed` (ou
-- supabase/seed.sql) para popular products.attributes.
-- =============================================================================

-- perfil de cada produto para o motor de recomendação
alter table public.products
  add column if not exists attributes jsonb not null default '{}'::jsonb;

-- resultados de quiz (salvos por token; user_id opcional)
create table if not exists public.skin_quizzes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  token      text not null unique,
  answers    jsonb not null,
  result     jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists skin_quizzes_user_idx  on public.skin_quizzes(user_id);
create index if not exists skin_quizzes_token_idx on public.skin_quizzes(token);

alter table public.skin_quizzes enable row level security;

-- o cliente logado enxerga os próprios quizzes (usado pelo /conta).
-- Inserção e leitura por token de convidado passam pelo backend (service-role).
drop policy if exists "own quizzes - select" on public.skin_quizzes;
create policy "own quizzes - select" on public.skin_quizzes
  for select using (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 0005_offers.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — carrossel de ofertas da home
-- Rode DEPOIS de 0004_quiz.sql. Depois `npm run seed` popula os slides padrão.
-- =============================================================================

create table if not exists public.offers (
  id         uuid primary key default gen_random_uuid(),
  position   int not null default 0,
  is_active  boolean not null default true,
  image_url  text not null default '',
  eyebrow    text not null default '',
  title      text not null default '',
  subtitle   text not null default '',
  cta_label  text not null default '',
  cta_href   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists offers_position_idx on public.offers(position);

drop trigger if exists offers_touch on public.offers;
create trigger offers_touch before update on public.offers
  for each row execute function public.touch_updated_at();

alter table public.offers enable row level security;

drop policy if exists "active offers readable" on public.offers;
create policy "active offers readable" on public.offers
  for select using (is_active = true);
-- escrita: somente via service-role (backend)


-- ─────────────────────────────────────────────────────────────────────────────
-- 0006_categories.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — categorias em árvore de 2 níveis (categoria → subcategoria)
-- Produto pertence sempre a uma subcategoria (nível 2), nunca a uma raiz.
-- Rode DEPOIS de 0005_offers.sql. Depois `npm run seed`.
-- =============================================================================

alter table public.categories
  add column if not exists image_url text not null default '';

alter table public.categories
  add column if not exists parent_id uuid references public.categories(id) on delete cascade;

-- limpeza de colunas de versões anteriores nunca aplicadas
alter table public.categories drop column if exists links;
alter table public.categories drop column if exists subcategories;

create index if not exists categories_parent_idx on public.categories(parent_id);

-- ----------------------------------------------------------------------------
-- Guard: a árvore tem no máximo 2 níveis
-- ----------------------------------------------------------------------------
create or replace function public.categories_depth_guard()
returns trigger language plpgsql as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Uma categoria não pode ser pai de si mesma';
    end if;
    if exists (select 1 from public.categories where id = new.parent_id and parent_id is not null) then
      raise exception 'Só é permitido 2 níveis: a subcategoria não pode ter subcategorias';
    end if;
    if exists (select 1 from public.categories where parent_id = new.id) then
      raise exception 'Esta categoria tem subcategorias — não pode virar subcategoria';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists categories_depth on public.categories;
create trigger categories_depth before insert or update on public.categories
  for each row execute function public.categories_depth_guard();

-- ----------------------------------------------------------------------------
-- Guard: produto só pode apontar para uma subcategoria (nível 2)
-- ----------------------------------------------------------------------------
create or replace function public.products_subcategory_guard()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from public.categories where id = new.category_id and parent_id is not null
  ) then
    raise exception 'O produto deve pertencer a uma subcategoria (categoria de nível 2)';
  end if;
  return new;
end;
$$;

drop trigger if exists products_subcategory on public.products;
create trigger products_subcategory before insert or update on public.products
  for each row execute function public.products_subcategory_guard();


-- ─────────────────────────────────────────────────────────────────────────────
-- 0007_site_content.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- =============================================================================
-- Iarah — conteúdo editável do site (home CTA do quiz, "mais queridos", rodapé,
-- páginas Sobre e Contato, dados de atendimento).
-- Rode DEPOIS de 0006_categories.sql. Depois `npm run seed` popula os textos
-- padrão (não sobrescreve edições existentes).
-- =============================================================================

create table if not exists public.site_content (
  section    text primary key,
  is_active  boolean not null default true,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists site_content_touch on public.site_content;
create trigger site_content_touch before update on public.site_content
  for each row execute function public.touch_updated_at();

alter table public.site_content enable row level security;

drop policy if exists "site_content readable" on public.site_content;
create policy "site_content readable" on public.site_content
  for select using (true);
-- escrita: somente via service-role (backend)


-- ─────────────────────────────────────────────────────────────────────────────
-- 0008_barcode.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Código de barras (EAN/UPC) por produto — leitor no cadastro (Produtos) e
-- no Caixa. Único quando presente; NULLs não conflitam entre si (a própria
-- constraint unique já cria o índice de busca).
alter table public.products add column if not exists barcode text;
alter table public.products drop constraint if exists products_barcode_key;
alter table public.products add constraint products_barcode_key unique (barcode);


-- ─────────────────────────────────────────────────────────────────────────────
-- 0009_caixa.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Caixa (PDV interno) — venda de balcão feita pela área administrativa.
-- Reusa orders/order_items. NÃO é caixa fiscal: não emite NFC-e / cupom.
-- 'source' separa a venda do site ('web') da venda no balcão ('caixa').

alter table public.orders
  add column if not exists source text not null default 'web';

alter table public.orders
  drop constraint if exists orders_source_check;
alter table public.orders
  add constraint orders_source_check check (source in ('web', 'caixa'));

create index if not exists orders_source_idx on public.orders(source);

-- ----------------------------------------------------------------------------
-- RPC: registra uma venda de caixa (pedido já `paid`) e baixa o estoque, tudo
-- numa transação. Preço e nome vêm do banco — o cliente só manda product_id e
-- quantidade. Levanta exceção (rollback total) se faltar estoque.
--   p_items: jsonb array de { "product_id": <uuid>, "quantity": <int> }
-- Retorna o id do pedido criado.
-- ----------------------------------------------------------------------------
create or replace function public.caixa_checkout(
  p_order_number text,
  p_method       text,
  p_items        jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_line     record;
  v_prod     public.products%rowtype;
  v_subtotal int := 0;
  v_updated  int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Venda sem itens.';
  end if;

  insert into public.orders (
    order_number, status, source, customer_name, customer_email,
    subtotal_cents, total_cents, payment_method
  ) values (
    p_order_number, 'paid', 'caixa', 'Consumidor', '',
    0, 0, p_method
  )
  returning id into v_order_id;

  for v_line in
    select (e->>'product_id')::uuid                       as product_id,
           greatest(1, coalesce((e->>'quantity')::int, 1)) as quantity
    from jsonb_array_elements(p_items) e
  loop
    select * into v_prod from public.products
      where id = v_line.product_id
      for update;
    if not found then
      raise exception 'Produto não encontrado no catálogo.';
    end if;

    update public.products
      set stock = stock - v_line.quantity
      where id = v_line.product_id and stock >= v_line.quantity;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'Estoque insuficiente para "%".', v_prod.name;
    end if;

    insert into public.order_items (
      order_id, product_id, product_name, product_slug, unit_price_cents, quantity
    ) values (
      v_order_id, v_prod.id, v_prod.name, v_prod.slug, v_prod.price_cents, v_line.quantity
    );

    v_subtotal := v_subtotal + v_prod.price_cents * v_line.quantity;
  end loop;

  update public.orders
    set subtotal_cents = v_subtotal,
        total_cents    = v_subtotal
    where id = v_order_id;

  return v_order_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: cancela uma venda de caixa e DEVOLVE o estoque. Idempotente. Só age em
-- pedidos source='caixa' que ainda não estejam 'cancelled'.
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

  for v_line in
    select product_id, quantity from public.order_items where order_id = v_order.id
  loop
    update public.products
      set stock = stock + v_line.quantity
      where id = v_line.product_id;
  end loop;

  update public.orders
    set status = 'cancelled'
    where id = v_order.id;

  return 'cancelled';
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 0010_offer_mobile_image.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Imagem separada para mobile no slide do carrossel (retrato). O app já lê
-- `image_url_mobile` (OffersCarousel, repo/site.rowToOffer) e o form do admin
-- salva; faltava a coluna.
alter table public.offers add column if not exists image_url_mobile text not null default '';


-- =============================================================================
-- 0011_store_identity.sql
-- =============================================================================
-- Marca de identidade do banco: diz a qual loja este Supabase pertence.
-- O site e o seed da Visionário se recusam a usar um banco cuja marca não seja
-- 'visionario' (ou que não tenha marca e já tenha produtos — banco de outra loja).
-- Uma linha só (id = true). Sem políticas de RLS: só a service_role lê.
create table if not exists public.store_identity (
  id    boolean primary key default true check (id),
  store text not null
);
alter table public.store_identity enable row level security;


-- 0012_admin_users.sql
-- Acesso à área administrativa passa a usar a mesma conta de cliente
-- (Supabase Auth) em vez de uma senha única compartilhada. Uma conta é admin
-- quando tem uma linha aqui — nunca um campo em `profiles` (que o próprio
-- dono da conta pode editar via RLS): promover alguém a admin tem que ser
-- sempre uma ação manual no banco, nunca alcançável por nenhuma API pública.

create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.admin_users is
  'Contas com acesso a /admin. Inserir manualmente (SQL editor ou service role) — nunca via API pública.';

alter table public.admin_users enable row level security;
-- De propósito, nenhuma policy: sem policy, só o client service-role
-- (que ignora RLS) consegue ler ou escrever essa tabela.

-- Depois de rodar esta migration, promova sua própria conta:
--   insert into public.admin_users (user_id)
--   values ('<seu-user-id-do-auth.users>');

-- =============================================================================
-- 0013_users_roles_status.sql
-- =============================================================================
-- =============================================================================
-- Usuários: papéis e permissões da equipe + estado da conta dos clientes.
-- Reexecutável. Rode no SQL Editor depois de 0012_admin_users.sql.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Equipe (admin_users): papel e permissões por seção do painel.
--   dono   → acesso total, inclusive gerenciar usuários
--   equipe → só as seções em `permissions`
-- Quem já era admin antes desta migration vira dono (ninguém perde acesso).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_users' and column_name = 'role'
  ) then
    alter table public.admin_users
      add column role text not null default 'equipe' check (role in ('dono', 'equipe')),
      add column permissions text[] not null default '{}';
    update public.admin_users set role = 'dono';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Estado da conta do cliente: ativo | desativado | bloqueado, com motivo.
-- Sem linha aqui = ativo. Sem policies de RLS: só o backend (service role) lê
-- e grava — o próprio cliente não consegue se desbloquear.
-- ----------------------------------------------------------------------------
create table if not exists public.customer_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  status     text not null default 'ativo' check (status in ('ativo', 'desativado', 'bloqueado')),
  reason     text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.customer_accounts enable row level security;

-- histórico de cada mudança de estado (quem, quando, por quê)
create table if not exists public.customer_status_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null check (status in ('ativo', 'desativado', 'bloqueado')),
  reason     text not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists customer_status_log_user_idx on public.customer_status_log(user_id, created_at desc);
alter table public.customer_status_log enable row level security;

-- =============================================================================
-- 0014_stock_guards.sql
-- =============================================================================
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

-- =============================================================================
-- 0015_lock_rpcs.sql
-- =============================================================================
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

-- =============================================================================
-- 0016_roles_permissions.sql
-- =============================================================================
-- =============================================================================
-- Cargos e permissões da área administrativa.
--   Regra     → definida no código (src/lib/rbac.ts) e conferida no servidor
--   Permissão → grupo de regras de uma tela (admin_permissions)
--   Cargo     → conjunto de permissões (admin_roles + admin_role_permissions)
-- Cada membro da equipe (admin_users) tem um cargo. O cargo Dono (is_owner)
-- tem tudo e não é editável. Reexecutável. Rode no SQL Editor.
-- Sem policies de RLS: só o backend (service role) lê e grava.
-- =============================================================================

create table if not exists public.admin_permissions (
  id          uuid primary key default gen_random_uuid(),
  screen      text not null,
  name        text not null,
  description text not null default '',
  rules       text[] not null default '{}',
  created_at  timestamptz not null default now(),
  unique (screen, name)
);
alter table public.admin_permissions enable row level security;

create table if not exists public.admin_roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text not null default '',
  is_owner    boolean not null default false,
  created_at  timestamptz not null default now()
);
-- só um cargo Dono
create unique index if not exists admin_roles_one_owner on public.admin_roles (is_owner) where is_owner;
alter table public.admin_roles enable row level security;

create table if not exists public.admin_role_permissions (
  role_id       uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);
alter table public.admin_role_permissions enable row level security;

alter table public.admin_users
  add column if not exists role_id uuid references public.admin_roles(id) on delete set null;

-- ----------------------------------------------------------------------------
-- Permissões e cargos iniciais (só cria o que não existe; edições feitas nas
-- telas não são sobrescritas)
-- ----------------------------------------------------------------------------
insert into public.admin_permissions (screen, name, description, rules) values
  ('painel',       'Ver painel',                     'Resumo de vendas e pedidos.',                       '{painel.ver}'),
  ('caixa',        'Vender no Caixa',                'Registrar vendas de balcão.',                        '{caixa.vender}'),
  ('caixa',        'Cancelar vendas do Caixa',       'Cancelar venda e devolver ao estoque.',              '{caixa.vender,caixa.cancelar}'),
  ('produtos',     'Ver produtos',                   'Consultar o catálogo sem alterar.',                  '{produtos.ver}'),
  ('produtos',     'Cadastrar e editar produtos',    'Criar e alterar produtos, fotos, preço e estoque.',  '{produtos.ver,produtos.editar}'),
  ('produtos',     'Excluir produtos',               'Apagar ou desativar produtos.',                      '{produtos.ver,produtos.excluir}'),
  ('pedidos',      'Ver pedidos',                    'Consultar pedidos e dados de entrega.',              '{pedidos.ver}'),
  ('pedidos',      'Atualizar status de pedidos',    'Pago, enviado, entregue, cancelado.',                '{pedidos.ver,pedidos.status}'),
  ('ofertas',      'Gerenciar ofertas',              'Carrossel da página inicial.',                       '{ofertas.ver,ofertas.editar}'),
  ('categorias',   'Gerenciar categorias',           'Árvore de categorias da loja.',                      '{categorias.ver,categorias.editar}'),
  ('conteudo',     'Editar conteúdo do site',        'Textos, logo, rodapé, Sobre e Contato.',             '{conteudo.ver,conteudo.editar}'),
  ('usuarios',     'Ver clientes',                   'Ficha dos clientes, compras e pedidos.',             '{clientes.ver}'),
  ('usuarios',     'Bloquear e desbloquear clientes','Mudar o estado da conta do cliente.',                '{clientes.ver,clientes.estado}'),
  ('usuarios',     'Gerenciar equipe',               'Criar e editar membros e definir cargos.',           '{equipe.ver,equipe.gerenciar}'),
  ('notificacoes', 'Ver notificações',               'Avisos automáticos do sistema.',                     '{notificacoes.ver}')
on conflict (screen, name) do nothing;

insert into public.admin_roles (name, description, is_owner) values
  ('Dono',              'Acesso total, inclusive Permissões e Cargos.', true),
  ('Gerente',           'Cuida da loja no dia a dia, sem gerenciar a equipe.', false),
  ('Operador de caixa', 'Vende no balcão e consulta produtos.', false),
  ('Estoquista',        'Cadastra produtos e controla o estoque.', false)
on conflict (name) do nothing;

-- permissões dos cargos iniciais (só na primeira vez: cargo sem nenhuma)
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('Gerente', array['Ver painel','Cancelar vendas do Caixa','Cadastrar e editar produtos','Excluir produtos','Atualizar status de pedidos','Gerenciar ofertas','Gerenciar categorias','Editar conteúdo do site','Bloquear e desbloquear clientes','Ver notificações']),
      ('Operador de caixa', array['Vender no Caixa','Ver produtos','Ver notificações']),
      ('Estoquista', array['Cadastrar e editar produtos','Ver pedidos','Ver notificações'])
    ) as t(role_name, perms)
  loop
    if not exists (
      select 1 from public.admin_role_permissions rp join public.admin_roles ro on ro.id = rp.role_id where ro.name = r.role_name
    ) then
      insert into public.admin_role_permissions (role_id, permission_id)
      select ro.id, p.id from public.admin_roles ro, public.admin_permissions p
      where ro.name = r.role_name and p.name = any (r.perms)
      on conflict do nothing;
    end if;
  end loop;
end $$;

-- quem era "dono" no modelo anterior (0013) vira cargo Dono
update public.admin_users
  set role_id = (select id from public.admin_roles where is_owner)
  where role_id is null and role = 'dono';

-- a partir daqui o acesso vem só do cargo: zera os campos do modelo anterior
-- (um ex-"dono" sem cargo não pode voltar a ter acesso total)
update public.admin_users set role = 'equipe', permissions = '{}' where role_id is not null;

-- =============================================================================
-- 0017_split_payment_stock_notice.sql
-- =============================================================================
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

-- =============================================================================
-- 0018_permission_active.sql
-- =============================================================================
-- =============================================================================
-- Permissão ativa/inativa. Inativa não dá nenhuma regra a quem tem o cargo,
-- mas continua ligada aos cargos (reativar devolve o acesso).
-- Reexecutável. Rode no SQL Editor depois da 0017.
-- =============================================================================
alter table public.admin_permissions add column if not exists is_active boolean not null default true;

-- =============================================================================
-- 0019_admin_owner.sql
-- =============================================================================
-- =============================================================================
-- Cargo "Dono" vira "Administrador"; cargo ativo/inativo; Proprietário da
-- conta (e-mail do responsável legal) com troca confirmada por código.
-- Reexecutável. Rode no SQL Editor depois da 0018.
-- =============================================================================

-- cargo inativo: quem tem fica sem acesso a nenhuma tela (o Administrador não desativa)
alter table public.admin_roles add column if not exists is_active boolean not null default true;

-- e-mail do Proprietário: só no cargo Administrador (is_owner)
alter table public.admin_roles add column if not exists owner_email text;

update public.admin_roles set name = 'Administrador' where is_owner and name = 'Dono';

-- Proprietário inicial: a conta mais antiga com o cargo Administrador
update public.admin_roles r
  set owner_email = (
    select lower(u.email)
    from public.admin_users a
    join auth.users u on u.id = a.user_id
    where a.role_id = r.id
    order by u.created_at
    limit 1
  )
  where r.is_owner and r.owner_email is null;

-- Códigos de troca do Proprietário (6 dígitos, 15 min). Guarda só o hash.
create table if not exists public.owner_transfer_tokens (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  new_email    text not null,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  created_at   timestamptz not null default now()
);
-- sem policies: só o servidor (service role) lê e grava
alter table public.owner_transfer_tokens enable row level security;

-- =============================================================================
-- 0020_active_flags.sql
-- =============================================================================
-- =============================================================================
-- Ativo/inativo em categorias e membros da equipe.
--  - categoria inativa sai do menu, dos filtros e do sitemap da loja (os
--    produtos dela continuam à venda);
--  - membro inativo continua na equipe, mas fica sem acesso a nenhuma tela.
-- Reexecutável. Rode no SQL Editor depois da 0019.
-- =============================================================================
alter table public.categories  add column if not exists is_active boolean not null default true;
alter table public.admin_users add column if not exists is_active boolean not null default true;

-- =============================================================================
-- 0021_email_codes.sql
-- =============================================================================
-- =============================================================================
-- Códigos por e-mail para mais de um uso: troca do Proprietário ('owner') e
-- troca do próprio e-mail ('email'). Reaproveita a tabela da 0019.
-- Reexecutável. Rode no SQL Editor depois da 0020.
-- =============================================================================
alter table public.owner_transfer_tokens add column if not exists purpose text not null default 'owner';
create index if not exists owner_transfer_tokens_user_purpose on public.owner_transfer_tokens (requested_by, purpose);

-- =============================================================================
-- 0022_last_seen.sql
-- =============================================================================
-- =============================================================================
-- Último acesso ao painel (para "Online/Offline" na lista de Usuários).
-- Gravado pelo servidor no máximo a cada 2 minutos por pessoa.
-- Reexecutável. Rode no SQL Editor depois da 0021.
-- =============================================================================
alter table public.admin_users add column if not exists last_seen_at timestamptz;

-- =============================================================================
-- 0023_order_audit.sql
-- =============================================================================
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

-- =============================================================================
-- 0024_separating_cancel_request.sql
-- =============================================================================
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

-- =============================================================================
-- 0025_cancel_policy.sql
-- =============================================================================
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

-- =============================================================================
-- 0026_return_completed.sql
-- =============================================================================
-- =============================================================================
-- Devolução concluída: quando a loja recebeu o produto e estornou o valor.
-- O pedido vira Cancelado (o estoque volta pelo change_order_status).
-- Reexecutável. Rode no SQL Editor depois da 0025.
-- =============================================================================
alter table public.orders add column if not exists return_completed_at timestamptz;

-- =============================================================================
-- 0027_payment_settings.sql
-- =============================================================================
-- =============================================================================
-- Meios de pagamento da loja (Mercado Pago) e histórico das tentativas.
--  - payment_settings: uma linha só (id = 1). Access Token e segredo do
--    webhook ficam CRIPTOGRAFADOS pelo servidor (AES-256-GCM, chave em
--    CREDENTIALS_KEY na Vercel); a Public Key é pública por natureza.
--  - payment_attempts: cada cobrança criada e cada aviso do webhook, para
--    conciliação. response_payload vai SEM dados pessoais do pagador (LGPD).
-- Sem policies: só o servidor (service role) lê e grava.
-- Reexecutável. Rode no SQL Editor depois da 0026.
-- =============================================================================
create table if not exists public.payment_settings (
  id                    int primary key default 1 check (id = 1),
  mp_access_token_enc   text,
  mp_public_key         text,
  mp_webhook_secret_enc text,
  updated_at            timestamptz not null default now(),
  updated_by            uuid
);
alter table public.payment_settings enable row level security;

create table if not exists public.payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  order_id            uuid references public.orders(id) on delete set null,
  order_number        text,
  channel             text check (channel in ('pos', 'ecommerce')),
  kind                text not null default 'charge', -- charge | webhook | refund
  provider_payment_id text,
  status              text not null,
  amount_cents        int,
  response_payload    jsonb
);
create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id, created_at desc);
create index if not exists payment_attempts_provider_idx on public.payment_attempts (provider_payment_id);
alter table public.payment_attempts enable row level security;

-- =============================================================================
-- 0028_cancel_review.sql
-- =============================================================================
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
