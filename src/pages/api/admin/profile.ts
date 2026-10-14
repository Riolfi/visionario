import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { getOwnerEmail, isProprietor } from '../../../lib/repo/owner';

/**
 * POST /api/admin/profile — perfil de quem está logado no painel (qualquer
 * membro da equipe; o middleware já garantiu que é admin). Formulário HTML:
 * volta para /admin/perfil com ?ok=… ou ?erro=….
 *   acao=dados       full_name, phone
 *   acao=email       email, senha_atual
 *   acao=senha       senha_atual, nova, confirmar
 *   acao=sair-todos  encerra a sessão em todos os aparelhos
 */

const back = (redirect: (url: string) => Response, key: 'ok' | 'erro', code: string) =>
  redirect(`/admin/perfil?${key}=${code}`);

/** Confere a senha atual sem mexer na sessão do navegador. */
async function passwordMatches(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const sb = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return false;
  await sb.auth.signOut({ scope: 'local' }); // descarta a sessão de conferência
  return true;
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  const admin = supabaseAdmin();
  if (!user || !admin) return redirect('/entrar');

  const form = await request.formData();
  const acao = String(form.get('acao') || '');

  if (acao === 'dados') {
    const full_name = String(form.get('full_name') || '').trim().slice(0, 120);
    const phone = String(form.get('phone') || '').replace(/[^\d+()\s-]/g, '').trim().slice(0, 30);
    if (full_name.length < 2) return back(redirect, 'erro', 'nome');
    const { error } = await admin.from('profiles').upsert({ id: user.id, full_name, phone }, { onConflict: 'id' });
    return error ? back(redirect, 'erro', 'falha') : back(redirect, 'ok', 'dados');
  }

  if (acao === 'email') {
    const email = String(form.get('email') || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back(redirect, 'erro', 'email');
    if (email === user.email) return back(redirect, 'erro', 'mesmo-email');
    // o e-mail do Proprietário só muda pela troca com código (Cargos › Administrador)
    if (await isProprietor(user.email)) return back(redirect, 'erro', 'proprietario');
    if (email === (await getOwnerEmail())) return back(redirect, 'erro', 'email-em-uso');
    if (!(await passwordMatches(user.email ?? '', String(form.get('senha_atual') || '')))) {
      return back(redirect, 'erro', 'senha-atual');
    }
    // admin API: troca direto, sem e-mail de confirmação (a loja pode não ter SMTP)
    const { error } = await admin.auth.admin.updateUserById(user.id, { email, email_confirm: true });
    if (error) return back(redirect, 'erro', /already|registered|exists/i.test(error.message) ? 'email-em-uso' : 'falha');
    return back(redirect, 'ok', 'email');
  }

  if (acao === 'senha') {
    const nova = String(form.get('nova') || '');
    if (nova.length < 8) return back(redirect, 'erro', 'senha-curta');
    if (nova !== String(form.get('confirmar') || '')) return back(redirect, 'erro', 'senha-diferente');
    if (!(await passwordMatches(user.email ?? '', String(form.get('senha_atual') || '')))) {
      return back(redirect, 'erro', 'senha-atual');
    }
    const { error } = await admin.auth.admin.updateUserById(user.id, { password: nova });
    return error ? back(redirect, 'erro', 'falha') : back(redirect, 'ok', 'senha');
  }

  if (acao === 'sair-todos') {
    await locals.supabase?.auth.signOut({ scope: 'global' });
    return redirect('/entrar');
  }

  return back(redirect, 'erro', 'falha');
};
