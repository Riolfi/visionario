import type { APIRoute } from 'astro';
import { safeNextPath, withLoginFlag } from '../../../lib/auth';
import { claimGuestOrders } from '../../../lib/repo/orders';
import { getAdminAccess, isAdmin, isInactiveTeamEmail } from '../../../lib/repo/admin';

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const sb = locals.supabase;
  if (!sb) return redirect('/');

  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  const next = safeNextPath(String(form.get('next') || ''), '/');

  // membro da equipe desativado: recusa antes mesmo de conferir a senha
  if (await isInactiveTeamEmail(email)) return redirect(`/entrar?erro=inativo&next=${encodeURIComponent(next)}`);

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    // conta desativada/bloqueada pela loja (ban no Supabase Auth)
    const erro = error.code === 'user_banned' ? 'conta' : '1';
    return redirect(`/entrar?erro=${erro}&next=${encodeURIComponent(next)}`);
  }
  // segunda checagem (ex.: e-mail digitado diferente do cadastrado): não entra
  if (data.user?.id && (await getAdminAccess(data.user.id))?.inactive) {
    await sb.auth.signOut();
    return redirect(`/entrar?erro=inativo&next=${encodeURIComponent(next)}`);
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
