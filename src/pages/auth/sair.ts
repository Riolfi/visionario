import type { APIRoute } from 'astro';
import { clearSessionLimits } from '../../lib/session-limits';

export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  await locals.supabase?.auth.signOut();
  clearSessionLimits(cookies);
  return redirect('/');
};

// permite logout via link também (ex.: menu simples)
export const GET: APIRoute = async ({ locals, cookies, redirect }) => {
  await locals.supabase?.auth.signOut();
  clearSessionLimits(cookies);
  return redirect('/');
};
