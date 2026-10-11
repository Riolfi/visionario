# Setup — Visionário

O projeto roda **sem nenhuma configuração** em modo _fallback_ (catálogo do arquivo
`src/data/catalog.json`, pagamento simulado, e-mail gravado em `.data/emails/`).
Para colocar em produção de verdade — e para usar o **Caixa** — configure o Supabase
(e, opcionalmente, Mercado Pago e Resend).

```bash
cp .env.example .env
npm install
npm run dev        # http://localhost:4321
```

Admin: `http://localhost:4321/admin` — entre em `/entrar` com uma conta que esteja na tabela `admin_users` (ver seção 4).

---

## 1. Supabase (banco de dados)

1. Crie um projeto **novo e exclusivo** em <https://supabase.com>. Nunca reutilize o
   Supabase de outra loja (Iarah ou qualquer outra): o site e o seed só aceitam um
   banco marcado como da Visionário (tabela `store_identity`, migration 0011) e
   recusam qualquer outro — banco de outra loja dá 503 no site e aborta o seed.
2. Em **SQL Editor**, rode **todas as migrations em ordem** — ou, num projeto novo,
   cole `supabase/all.sql` (as 9 juntas) de uma vez:
   - `0001_init.sql` — tabelas, RLS, função `confirm_order_payment`
   - `0002_accounts.sql` — contas de cliente (profiles, addresses, `orders.user_id`)
   - `0003_order_status.sql` — status enviado/entregue + rastreio
   - `0004_quiz.sql` — legado da Iarah (`products.attributes` + `skin_quizzes`), não usado mais
   - `0005_offers.sql` — carrossel de ofertas da home
   - `0006_categories.sql` — categorias em árvore de 2 níveis (`parent_id`) + imagem;
     triggers que garantem "só 2 níveis" e "produto pertence a uma subcategoria"
   - `0007_site_content.sql` — conteúdo editável das seções do site (CTA e
     "mais queridos" na home, rodapé, páginas Sobre e Contato, dados de atendimento)
   - `0008_barcode.sql` — coluna `products.barcode` (EAN/UPC, único) para o leitor
   - `0009_caixa.sql` — coluna `orders.source` + funções `caixa_checkout` /
     `cancel_caixa_sale` para o Caixa (PDV interno, venda de balcão)
   - `0010_offer_mobile_image.sql` — coluna `offers.image_url_mobile`
   - `0011_store_identity.sql` — marca de identidade do banco (o seed grava
     `visionario` num banco vazio; banco com produtos e sem marca é recusado)
   Depois rode `npm run seed` (popula catálogo, categorias, ofertas e os textos
   padrão do site). É idempotente. Num banco com dados de outra loja, use
   `npm run seed -- --reset`: apaga produtos fora do `catalog.json` (os com pedido
   ficam inativos), troca as ofertas e sobrescreve os textos do site.
3. Em **Project Settings → API**, copie para o `.env`:
   - `SUPABASE_URL` → "Project URL"
   - `SUPABASE_ANON_KEY` → chave publishable (`sb_publishable_…`) ou `anon` (só servidor; sem prefixo `PUBLIC_`)
   - `SUPABASE_SERVICE_ROLE_KEY` → chave `service_role` (⚠️ secreta, só backend)

Assim que `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` estiverem definidas, o site passa a
ler/gravar tudo no Supabase automaticamente (o modo fallback é desativado).

> **Produção exige Supabase.** Em serverless o filesystem é somente-leitura, então o
> fallback em `.data/` só funciona no desenvolvimento local.

### Tema

Paleta, fontes e raio de borda vêm de `src/data/theme.json` — trocar os valores ali
re-skina a loja inteira (o build lê o arquivo). `agua.{DEFAULT,light,dark,wash}` viram
variáveis CSS via `src/components/ThemeVars.astro` (incluído em todo `<html>` —
`BaseLayout` e `AdminLayout`).

### RLS (resumo)

- `categories` / `products`: leitura pública (produtos só se `is_active`).
- `orders` / `order_items`: **sem** políticas → inacessíveis para o cliente; o backend
  usa a `service_role` key, que ignora RLS.
- Baixa de estoque: função `confirm_order_payment()` (atômica e idempotente), chamada
  só pelo backend na confirmação do pagamento. O Caixa usa `caixa_checkout()` (mesma
  ideia: cria o pedido `paid` com `source='caixa'` e baixa o estoque numa transação);
  `cancel_caixa_sale()` estorna e devolve o estoque.

### Contas de cliente (login / "Minha conta")

A área `/conta` (histórico de pedidos, perfil, endereços) usa **Supabase Auth** e só
aparece quando o Supabase está configurado. Para ativar:

1. Rode também `supabase/migrations/0002_accounts.sql` (tabelas `profiles`, `addresses`,
   coluna `orders.user_id`, RLS e trigger que cria o profile no cadastro),
   `supabase/migrations/0003_order_status.sql` (status "enviado"/"entregue" + rastreio).
2. **Authentication → Providers → Email**: mantenha habilitado. "Confirm email" ligado
   exige que o Resend/SMTP esteja configurado (senão o link de confirmação não chega —
   em dev ele é gravado em `.data/emails/`). Para testar rápido, desligue "Confirm email".
3. **Authentication → Providers → Google**: habilite e cole o *Client ID* e *Client
   Secret* de um OAuth Client do Google Cloud Console (tipo "Web application"). Em
   *Authorized redirect URIs* do Google, use a URL que o Supabase mostra
   (`https://<projeto>.supabase.co/auth/v1/callback`).
4. **Authentication → URL Configuration**: em *Site URL* coloque o domínio do site
   (`http://localhost:4321` em dev) e adicione `<site>/auth/callback` em *Redirect URLs*.

Pedidos feitos como convidado são vinculados automaticamente à conta quando o cliente
se cadastra com o mesmo e-mail.

### Upload de imagens de produto

O `/admin` permite enviar imagens do computador no cadastro do produto. Com o Supabase
configurado, elas vão para o bucket **público** `product-images` (criado
automaticamente no primeiro upload). Sem Supabase, ficam em `.data/uploads/` e são
servidas por `/uploads/<arquivo>` — só funciona no dev local.

---

## 2. Mercado Pago (Checkout Bricks — Pix + cartão)

1. Crie uma aplicação em <https://www.mercadopago.com.br/developers/panel/app>.
2. Em **Credenciais de teste**, copie:
   - `PUBLIC_MP_PUBLIC_KEY` → "Public Key" (`TEST-...`)
   - `MP_ACCESS_TOKEN` → "Access Token" (`TEST-...`)
3. Em **Webhooks**, configure a URL de notificação:
   `https://SEU-DOMINIO/api/webhooks/mercadopago` — evento **Pagamentos**.
   Copie a **assinatura secreta** para `MP_WEBHOOK_SECRET`.
4. Para produção real, repita com as credenciais de **produção** (`APP_USR-...`).

Sem essas chaves, o checkout exibe "Modo demonstração" e um botão que **simula** um
pagamento aprovado, rodando todo o pipeline real (pedido pago → baixa de estoque → e-mail).

### Cartões de teste (sandbox)

| Bandeira | Número | CVV | Validade |
|---|---|---|---|
| Mastercard | 5031 4332 1540 6351 | 123 | 11/30 |
| Visa | 4235 6477 2802 5682 | 123 | 11/30 |

Para simular status use o nome do titular: `APRO` (aprovado), `OTHE` (recusado geral),
`CONT` (pendente). CPF de teste: `12345678909`.

Pix de teste é aprovado pelo painel **Atividade → pagamento → "Marcar como pago"**.

---

## 3. Resend (e-mail de confirmação)

1. Crie a conta em <https://resend.com> e verifique um domínio (ou use `onboarding@resend.dev` para testes).
2. Crie uma API key → `RESEND_API_KEY`.
3. Defina `RESEND_FROM`, ex.: `Visionário <pedidos@seudominio.com.br>`.

Sem a chave, o e-mail de confirmação é gravado em `.data/emails/<numero-do-pedido>.html`.

---

## 4. Admin

O `/admin` usa a mesma conta de cliente (Supabase Auth). Uma conta é admin
quando tem uma linha em `admin_users` — rode `supabase/migrations/0012_admin_users.sql`
uma vez e promova a conta no SQL editor:

```sql
insert into public.admin_users (user_id)
select id from auth.users where email = 'admin@visionario.com.br';
```

Conta de admin **só acessa o painel**: logada (inclusive pelo cookie de uma sessão
antiga), qualquer página da loja leva para `/admin`, e as APIs de cliente (pedido,
checkout, conta) respondem 403.

Para ver a loja como cliente, use a **conta de cliente de teste**:

```bash
npm run test-user
```

Cria `cliente-teste@visionario.test` (ou gera uma senha nova, se já existe) e mostra
a senha só no terminal. Para outro e-mail: `npm run test-user -- outro@email`.

---

## 5. Deploy na Vercel

1. Suba o repositório no GitHub e importe em <https://vercel.com/new>.
2. Framework detectado automaticamente: **Astro**. Nada a configurar no build.
3. Em **Settings → Environment Variables**, adicione todas as chaves do `.env`
   (inclusive `PUBLIC_SITE_URL` com o domínio final, ex.: `https://lojavisionario.com.br`).
4. Deploy. O adapter `@astrojs/vercel` gera as serverless functions das rotas SSR e das APIs.
5. Volte ao painel do Mercado Pago e ajuste a URL do webhook para o domínio de produção.

### Checklist pós-deploy

- [ ] `PUBLIC_SITE_URL` aponta para o domínio real (afeta SEO, sitemap, e-mails, retorno do checkout)
- [ ] `supabase/migrations` + `seed` rodados no projeto de produção
- [ ] Webhook do Mercado Pago apontando para produção + `MP_WEBHOOK_SECRET` conferida
- [ ] Domínio do Resend verificado
- [ ] `/sitemap-index.xml` e `/robots.txt` acessíveis
- [ ] Teste de compra ponta a ponta com cartão de teste
