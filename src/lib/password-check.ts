import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/** Confere a senha atual sem mexer na sessão do navegador. */
export async function passwordMatches(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const sb = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return false;
  await sb.auth.signOut({ scope: 'local' }); // descarta a sessão de conferência
  return true;
}
