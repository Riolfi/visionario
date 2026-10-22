import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { isAdmin } from '../../../lib/repo/admin';
import { verifyPasswordSetupToken } from '../../../lib/password-link';

/**
 * POST /api/auth/criar-senha — t (link assinado com o e-mail), atual (senha
 * temporária), nova, confirmar. Confere a temporária, grava a nova, tira a
 * marca de troca obrigatória e já entra na conta (encerrando quem estava
 * logado neste navegador).
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const t = String(form.get('t') || '');
  const back = (erro: string) => redirect(`/criar-senha?t=${encodeURIComponent(t)}&erro=${erro}`);
  const email = verifyPasswordSetupToken(t);
  const admin = supabaseAdmin();
  if (!email || !admin) return redirect(`/criar-senha?t=${encodeURIComponent(t)}`);

  const atual = String(form.get('atual') || '');
  const nova = String(form.get('nova') || '');
  if (nova.length < 8) return back('curta');
  if (nova !== String(form.get('confirmar') || '')) return back('diferente');
  if (nova === atual) return back('igual');

  // confere a temporária sem mexer na sessão do navegador
  const probe = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: wrong } = await probe.auth.signInWithPassword({ email, password: atual });
  if (wrong || !data.user) return back('atual');
  await probe.auth.signOut({ scope: 'local' });
  // só para quem ainda está com a senha temporária
  if (!data.user.app_metadata?.must_change_password) return back('ja');

  const { error } = await admin.auth.admin.updateUserById(data.user.id, {
    password: nova,
    app_metadata: { ...data.user.app_metadata, must_change_password: false },
  });
  if (error) return back('falha');

  // entra com a senha nova (quem estava logado aqui sai)
  const sb = locals.supabase;
  if (sb) {
    if (locals.user) await sb.auth.signOut({ scope: 'local' });
    const { error: login } = await sb.auth.signInWithPassword({ email, password: nova });
    if (login) return redirect('/entrar?ok=senha');
  }
  return redirect((await isAdmin(data.user.id)) ? '/admin' : '/');
};
