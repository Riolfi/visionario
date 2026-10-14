import { Resend } from 'resend';
import { env, hasResend, hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Proprietário da conta: e-mail do responsável legal, guardado no cargo
 * Administrador (admin_roles.owner_email, migration 0019). Só quem entra com
 * esse e-mail pode trocá-lo e dar/tirar o cargo Administrador. A troca só vale
 * depois de um código de 6 dígitos (15 min) enviado ao e-mail ATUAL.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

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

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pede a troca: confere quem pede, valida o novo e-mail (precisa ser de alguém
 * com o cargo Administrador) e manda o código ao e-mail atual.
 */
export async function requestOwnerTransfer(actor: { userId: string; email: string | null | undefined }, newEmailRaw: string): Promise<Result> {
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
  if (!found) return { ok: false, error: 'O novo Proprietário precisa ter uma conta com o cargo Administrador. Dê o cargo a ele em Usuários antes.' };
  if (!hasResend) return { ok: false, error: 'O envio de e-mail não está configurado (RESEND_API_KEY); sem ele o código não chega.' };

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const id = crypto.randomUUID();
  await sb.from('owner_transfer_tokens').delete().eq('requested_by', actor.userId); // só o último vale
  const { error } = await sb.from('owner_transfer_tokens').insert({
    id,
    requested_by: actor.userId,
    new_email: newEmail,
    code_hash: await sha256(`${id}:${code}`),
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  if (error) return { ok: false, error: error.message };

  try {
    const { error: mailErr } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: current, // sempre o e-mail ATUAL, nunca o novo
      subject: `Código para trocar o Proprietário — ${env.brandName}`,
      html: `<p>Foi pedida a troca do Proprietário da conta ${env.brandName} para <strong>${newEmail.replace(/</g, '&lt;')}</strong>.</p>
        <p>Código: <strong style="font-size:22px;letter-spacing:4px">${code}</strong></p>
        <p>Vale por 15 minutos. Se não foi você, ignore este e-mail e troque a sua senha.</p>`,
    });
    if (mailErr) throw new Error(mailErr.message);
  } catch (e) {
    await sb.from('owner_transfer_tokens').delete().eq('id', id);
    return { ok: false, error: `Não foi possível enviar o código (${e instanceof Error ? e.message : 'erro'}).` };
  }
  return { ok: true };
}

/** Confere o código e só então grava o novo Proprietário. */
export async function confirmOwnerTransfer(actor: { userId: string; email: string | null | undefined }, codeRaw: string): Promise<Result & { newEmail?: string }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (!(await isProprietor(actor.email))) return { ok: false, error: 'Só o Proprietário pode alterar este campo.' };
  const { data: tok } = await sb
    .from('owner_transfer_tokens')
    .select('*')
    .eq('requested_by', actor.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tok) return { ok: false, error: 'Nenhuma troca pendente. Salve de novo para receber outro código.' };
  if (new Date(tok.expires_at).getTime() < Date.now()) {
    await sb.from('owner_transfer_tokens').delete().eq('id', tok.id);
    return { ok: false, error: 'O código expirou. Salve de novo para receber outro.' };
  }
  if (tok.attempts >= MAX_ATTEMPTS) {
    await sb.from('owner_transfer_tokens').delete().eq('id', tok.id);
    return { ok: false, error: 'Muitas tentativas erradas. Salve de novo para receber outro código.' };
  }
  const code = codeRaw.replace(/\D/g, '');
  if (code.length !== 6 || (await sha256(`${tok.id}:${code}`)) !== tok.code_hash) {
    await sb.from('owner_transfer_tokens').update({ attempts: tok.attempts + 1 }).eq('id', tok.id);
    return { ok: false, error: 'Código incorreto.' };
  }
  const { error } = await sb.from('admin_roles').update({ owner_email: tok.new_email }).eq('is_owner', true);
  if (error) return { ok: false, error: error.message };
  await sb.from('owner_transfer_tokens').delete().eq('requested_by', actor.userId);
  return { ok: true, newEmail: tok.new_email };
}
