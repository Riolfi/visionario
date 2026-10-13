import type { APIRoute } from 'astro';
import { safeNextPath, withLoginFlag } from '../../../lib/auth';
import { claimGuestOrders } from '../../../lib/repo/orders';
import { isAdmin } from '../../../lib/repo/admin';

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const sb = locals.supabase;
  if (!sb) return redirect('/');

  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  const next = safeNextPath(String(form.get('next') || ''), '/');

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    // conta desativada/bloqueada pela loja (ban no Supabase Auth)
    const erro = error.code === 'user_banned' ? 'conta' : '1';
    return redirect(`/entrar?erro=${erro}&next=${encodeURIComponent(next)}`);
  }
  // vincula pedidos feitos como convidado antes de a conta existir
  if (data.user?.id && data.user.email) {
    await claimGuestOrders(data.user.email, data.user.id);
  }
  // admin sem destino explícito vai pro painel; cliente volta pra onde
  // estava (padrão: página inicial) com o aviso de "você entrou"
  if (next === '/' && data.user?.id && (await isAdmin(data.user.id))) return redirect('/admin');
  return redirect(withLoginFlag(next));
};
