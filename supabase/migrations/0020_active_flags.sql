-- =============================================================================
-- Ativo/inativo em categorias e membros da equipe.
--  - categoria inativa sai do menu, dos filtros e do sitemap da loja (os
--    produtos dela continuam à venda);
--  - membro inativo continua na equipe, mas fica sem acesso a nenhuma tela.
-- Reexecutável. Rode no SQL Editor depois da 0019.
-- =============================================================================
alter table public.categories  add column if not exists is_active boolean not null default true;
alter table public.admin_users add column if not exists is_active boolean not null default true;
