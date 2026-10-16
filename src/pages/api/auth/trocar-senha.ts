import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { isAdmin } from '../../../lib/repo/admin';

/**
 * POST /api/auth/trocar-senha — nova senha no lugar da temporária (conta
 * criada ou senha redefinida por um administrador). Só vale para quem está
 * com app_metadata.must_change_password; ao salvar, a marca sai.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  const admin = supabaseAdmin();
  if (!user || !admin) return redirect('/entrar');
  if (!user.app_metadata?.must_change_password) return redirect('/');

  const form = await request.formData();
  const nova = String(form.get('nova') || '');
  if (nova.length < 8) return redirect('/trocar-senha?erro=curta');
  if (nova !== String(form.get('confirmar') || '')) return redirect('/trocar-senha?erro=diferente');

  const probe = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // confirma a senha recebida (definida pelo Administrador)
  const { error: wrong } = await probe.auth.signInWithPassword({ email: user.email ?? '', password: String(form.get('atual') || '') });
  if (wrong) return redirect('/trocar-senha?erro=atual');
  await probe.auth.signOut({ scope: 'local' });
  // a nova não pode ser a temporária (o administrador a conhece)
  const { error: same } = await probe.auth.signInWithPassword({ email: user.email ?? '', password: nova });
  if (!same) {
    await probe.auth.signOut({ scope: 'local' });
    return redirect('/trocar-senha?erro=igual');
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password: nova,
    app_metadata: { ...user.app_metadata, must_change_password: false },
  });
  if (error) return redirect('/trocar-senha?erro=falha');
  return redirect((await isAdmin(user.id)) ? '/admin' : '/');
};
