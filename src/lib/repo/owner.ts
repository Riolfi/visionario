import { env, hasSupabase } from '../env';
import { issueCode } from './email-codes';
import { supabaseAdmin } from '../supabase';

/**
 * Proprietário da conta: e-mail do responsável legal, guardado no cargo
 * Administrador (admin_roles.owner_email, migration 0019). Só quem entra com
 * esse e-mail pode trocá-lo e dar/tirar o cargo Administrador. A troca só vale
 * depois de um código de 6 dígitos (15 min) enviado ao e-mail ATUAL
 * (ver email-codes).
 */

type Result = { ok: true } | { ok: false; error: string };

const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

/** E-mail do Proprietário (null antes da migration 0019 ou se vazio). */
export async function getOwnerEmail(): Promise<string | null> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return null;
  const { data, error } = await sb.from('admin_roles').select('*').eq('is_owner', true).limit(1).maybeSingle();
  if (error || !data) return null;
  return norm(data.owner_email) || null;
}

/** Quem está logado é o Proprietário? (e-mail idêntico, sem diferenciar maiúscula) */
export async function isProprietor(email: string | null | undefined): Promise<boolean> {
  const owner = await getOwnerEmail();
  return !!owner && owner === norm(email);
}

/**
 * Pede a troca: confere quem pede, valida o novo e-mail (precisa ser de alguém
 * com o cargo Administrador) e manda o código ao e-mail atual.
 */
export async function requestOwnerTransfer(
  actor: { userId: string; email: string | null | undefined },
  newEmailRaw: string,
  /** o cargo Administrador está sendo dado no mesmo salvar (o Proprietário escolheu no Cargo) */
  opts: { becomingAdmin?: boolean } = {},
): Promise<Result> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const current = await getOwnerEmail();
  if (!current) return { ok: false, error: 'Rode a migration 0019_admin_owner.sql no Supabase.' };
  if (current !== norm(actor.email)) return { ok: false, error: 'Só o Proprietário pode alterar este campo.' };
  const newEmail = norm(newEmailRaw);
  if (!newEmail) return { ok: false, error: 'O Proprietário não pode ficar em branco.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return { ok: false, error: 'E-mail do Proprietário inválido.' };
  if (newEmail === current) return { ok: false, error: 'Esse já é o e-mail do Proprietário.' };

  // o novo Proprietário precisa ser alguém da equipe com o cargo Administrador
  const { data: admins } = await sb.from('admin_users').select('user_id, admin_roles!inner(is_owner)').eq('admin_roles.is_owner', true);
  let found = false;
  for (const a of admins ?? []) {
    const { data } = await sb.auth.admin.getUserById(a.user_id);
    if (norm(data.user?.email) === newEmail) found = true;
  }
  if (!found && !opts.becomingAdmin) return { ok: false, error: 'O novo Proprietário precisa ter o cargo Administrador. Escolha Administrador no campo Cargo.' };

  // código sempre ao e-mail ATUAL, nunca ao novo
  return issueCode({
    userId: actor.userId,
    purpose: 'owner',
    newEmail,
    sendTo: current,
    subject: 'Código para trocar o Proprietário',
    intro: `Foi pedida a troca do Proprietário da conta ${env.brandName} para ${newEmail}.`,
  });
}
