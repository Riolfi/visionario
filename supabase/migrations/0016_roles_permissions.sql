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
