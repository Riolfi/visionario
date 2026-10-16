import { Resend } from 'resend';
import { env, hasResend, hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Códigos de 6 dígitos por e-mail (15 min, 5 tentativas), para confirmar
 * ações sensíveis: troca do Proprietário e do próprio e-mail. Guarda só o
 * hash (tabela owner_transfer_tokens, migrations 0019 e 0021). Um código
 * novo do mesmo tipo invalida o anterior.
 */
export type CodePurpose = 'owner' | 'email';

const TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TABLE = 'owner_transfer_tokens';

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Gera o código, guarda o hash e manda para `sendTo`. */
export async function issueCode(opts: {
  userId: string;
  purpose: CodePurpose;
  /** o que fica pendente até confirmar (novo e-mail) */
  newEmail: string;
  sendTo: string;
  subject: string;
  /** frase antes do código, em texto puro */
  intro: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  if (!hasResend) return { ok: false, error: 'O envio de e-mail não está configurado (RESEND_API_KEY); sem ele o código não chega.' };

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
  const id = crypto.randomUUID();
  await sb.from(TABLE).delete().eq('requested_by', opts.userId).eq('purpose', opts.purpose); // só o último vale
  const { error } = await sb.from(TABLE).insert({
    id,
    requested_by: opts.userId,
    purpose: opts.purpose,
    new_email: opts.newEmail,
    code_hash: await sha256(`${id}:${code}`),
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  if (error) return { ok: false, error: /purpose/.test(error.message) ? 'Rode a migration 0021_email_codes.sql no Supabase.' : error.message };

  try {
    const { error: mailErr } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: opts.sendTo,
      subject: `${opts.subject} — ${env.brandName}`,
      html: `<p>${esc(opts.intro)}</p>
        <p>Código: <strong style="font-size:22px;letter-spacing:4px">${code}</strong></p>
        <p>Vale por 15 minutos. Se não foi você, ignore este e-mail e troque a sua senha.</p>`,
    });
    if (mailErr) throw new Error(mailErr.message);
  } catch (e) {
    await sb.from(TABLE).delete().eq('id', id);
    return { ok: false, error: `Não foi possível enviar o código (${e instanceof Error ? e.message : 'erro'}).` };
  }
  return { ok: true };
}

/** Confere o código; certo, apaga e devolve o valor pendente (novo e-mail). */
export async function consumeCode(
  userId: string,
  purpose: CodePurpose,
  codeRaw: string,
): Promise<{ ok: true; newEmail: string } | { ok: false; error: string }> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return { ok: false, error: 'Supabase não configurado.' };
  const { data: tok } = await sb
    .from(TABLE)
    .select('*')
    .eq('requested_by', userId)
    .eq('purpose', purpose)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!tok) return { ok: false, error: 'Nenhum código pendente. Peça outro.' };
  if (new Date(tok.expires_at).getTime() < Date.now()) {
    await sb.from(TABLE).delete().eq('id', tok.id);
    return { ok: false, error: 'O código expirou. Peça outro.' };
  }
  if (tok.attempts >= MAX_ATTEMPTS) {
    await sb.from(TABLE).delete().eq('id', tok.id);
    return { ok: false, error: 'Muitas tentativas erradas. Peça outro código.' };
  }
  const code = codeRaw.replace(/\D/g, '');
  if (code.length !== 6 || (await sha256(`${tok.id}:${code}`)) !== tok.code_hash) {
    await sb.from(TABLE).update({ attempts: tok.attempts + 1 }).eq('id', tok.id);
    return { ok: false, error: 'Código incorreto.' };
  }
  await sb.from(TABLE).delete().eq('requested_by', userId).eq('purpose', purpose);
  return { ok: true, newEmail: tok.new_email };
}
