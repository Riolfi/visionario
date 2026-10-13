import { defineMiddleware } from 'astro:middleware';
import { getServerClient } from './lib/supabase-server';
import { env, hasSupabasePublic } from './lib/env';
import { getSiteContent } from './lib/repo/site';
import { DEFAULT_SITE_CONTENT } from './lib/site-defaults';
import { checkStoreIdentity } from './lib/supabase';
import { canAccess, getAdminAccess, homeFor, type AdminAccess } from './lib/repo/admin';
import { getCustomerStatus } from './lib/repo/customers';

// O que uma conta de administrador pode abrir fora de /admin: login/sair,
// fotos enviadas e as APIs que o próprio painel chama (status do Pix na
// Caixa, CEP). O resto é loja, e admin não compra como cliente.
const ADMIN_ALLOWED = ['/auth/', '/api/auth/', '/uploads/', '/api/payments/status', '/api/cep/'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Banco de outra loja → não lê nem grava nada.
  const identityError = await checkStoreIdentity();
  if (identityError) {
    console.error('[store-identity]', identityError);
    // motivo no header (sem segredos) para diagnosticar sem acesso aos logs
    return new Response('Loja temporariamente indisponível.', {
      status: 503,
      headers: { 'x-store-identity': encodeURIComponent(identityError).slice(0, 300) },
    });
  }

  // -------------------------------------------------------------------------
  // Sessão do cliente (Supabase Auth) — só quando o Supabase está configurado
  // -------------------------------------------------------------------------
  context.locals.user = null;
  context.locals.supabase = null;

  context.locals.brand = { name: env.brandName };
  context.locals.accent = null;

  // Conteúdo editável do site — uma leitura por request, compartilhada por
  // página + Header/Footer/BaseLayout. Rotas de API não usam.
  context.locals.site = DEFAULT_SITE_CONTENT;
  if (!pathname.startsWith('/api/')) {
    context.locals.site = await getSiteContent();
  }

  const accountArea =
    pathname === '/conta' ||
    pathname.startsWith('/conta/') ||
    pathname.startsWith('/api/account');
  const authArea =
    pathname === '/entrar' || pathname === '/cadastrar' || pathname.startsWith('/auth/');

  const isAdminArea = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
  let access: AdminAccess | null = null;
  context.locals.admin = null;
  if (hasSupabasePublic) {
    const supabase = getServerClient(context.request, context.cookies);
    context.locals.supabase = supabase;
    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      context.locals.user = user;
      access = user ? await getAdminAccess(user.id) : null;
      context.locals.admin = access;

      // cliente com a conta desativada/bloqueada: encerra a sessão e barra
      if (user && !access && !pathname.startsWith('/auth/') && (await getCustomerStatus(user.id)) !== 'ativo') {
        await supabase.auth.signOut();
        context.locals.user = null;
        if (pathname.startsWith('/api/')) {
          return new Response(JSON.stringify({ error: 'Conta desativada ou bloqueada.' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return context.redirect('/entrar?erro=conta');
      }
    }

    // Conta de administrador vê sempre o painel — inclusive quem já chega
    // logado pelo cookie. A loja (páginas e APIs de cliente) fica fechada pra ela.
    if (access && !isAdminArea && !ADMIN_ALLOWED.some((p) => pathname.startsWith(p))) {
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Conta de administrador não compra pela loja.' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return context.redirect(homeFor(access));
    }

    if (accountArea && !context.locals.user) {
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Não autenticado.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      const next = encodeURIComponent(pathname + context.url.search);
      return context.redirect(`/entrar?next=${next}`);
    }
  } else if (accountArea || authArea) {
    // Modo fallback: contas de cliente desligadas
    return context.redirect('/');
  }

  // -------------------------------------------------------------------------
  // Área administrativa — mesma conta de cliente (Supabase Auth), precisa
  // também ter uma linha em admin_users. A equipe só abre as seções liberadas
  // (o dono abre tudo). Sem Supabase não há como logar: área inacessível.
  // -------------------------------------------------------------------------
  if (isAdminArea) {
    if (access && !canAccess(access, pathname, context.request.method)) {
      if (pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Sem permissão para esta seção.' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return context.redirect(homeFor(access));
    }
    if (!access) {
      if (pathname.startsWith('/api/')) {
        const status = context.locals.user ? 403 : 401;
        const error = context.locals.user ? 'Sem permissão de administrador.' : 'Não autenticado.';
        return new Response(JSON.stringify({ error }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (context.locals.user) return context.redirect('/');
      const next = encodeURIComponent(pathname + context.url.search);
      return context.redirect(`/entrar?next=${next}`);
    }
  }

  return next();
});
