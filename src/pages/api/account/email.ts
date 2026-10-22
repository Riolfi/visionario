import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { consumeCode, issueCode } from '../../../lib/repo/email-codes';
import { getOwnerEmail } from '../../../lib/repo/owner';
import { passwordMatches } from '../../../lib/password-check';
import { sendAccountChangeNotice } from '../../../lib/email';
import { sendNewEmailCode } from '../../../lib/email-change';

/**
 * POST /api/account/email — cliente troca o e-mail da conta, com a mesma
 * regra da equipe:
 *   acao=pedir   email, confirmar, senha_atual → código de 6 dígitos ao
 *                e-mail ATUAL (quem entrou só pelo Google não tem senha: só o código)
 *   acao=codigo       code do e-mail atual → manda o 2º código ao e-mail NOVO
 *   acao=codigo-novo  code do e-mail novo → troca o e-mail e avisa o endereço antigo
 */
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  const admin = supabaseAdmin();
  if (!user || !admin) return redirect('/entrar');
  const form = await request.formData();
  const back = (q: string) => redirect(`/conta/perfil?${q}`);
  const hasPassword = ((user.app_metadata?.providers as string[] | undefined) ?? [user.app_metadata?.provider]).includes('email');

  if (form.get('acao') === 'pedir') {
    const email = String(form.get('email') || '').trim().toLowerCase();
    if (!isEmail(email)) return back('email=erro&motivo=invalido');
    if (email !== String(form.get('confirmar') || '').trim().toLowerCase()) return back('email=erro&motivo=confirmacao');
    if (email === (user.email ?? '').toLowerCase()) return back('email=erro&motivo=igual');
    if (email === (await getOwnerEmail())) return back('email=erro&motivo=em-uso');
    if (hasPassword && !(await passwordMatches(user.email ?? '', String(form.get('senha_atual') || '')))) return back('email=erro&motivo=senha');
    // a troca só vale com o código enviado ao e-mail atual (sessão roubada não troca o e-mail)
    const sent = await issueCode({
      userId: user.id,
      purpose: 'email',
      newEmail: email,
      sendTo: user.email ?? '',
      subject: 'Código para trocar o seu e-mail',
      intro: `Foi pedida a troca do e-mail da sua conta para ${email}.`,
    });
    return sent.ok ? back('email=codigo') : back('email=erro&motivo=envio');
  }

  if (form.get('acao') === 'codigo') {
    const r = await consumeCode(user.id, 'email', String(form.get('code') || ''));
    if (!r.ok) return back(`email=codigo&motivo=${/expirou|Nenhum|tentativas/.test(r.error) ? 'codigo-novo' : 'codigo'}`);
    const sent = await sendNewEmailCode(user.id, r.newEmail);
    return sent.ok ? back('email=codigo-novo') : back('email=erro&motivo=envio');
  }

  if (form.get('acao') === 'codigo-novo') {
    const r = await consumeCode(user.id, 'email-new', String(form.get('code') || ''));
    if (!r.ok) return back(`email=codigo-novo&motivo=${/expirou|Nenhum|tentativas/.test(r.error) ? 'codigo-novo' : 'codigo'}`);
    const old = user.email ?? '';
    const { error } = await admin.auth.admin.updateUserById(user.id, { email: r.newEmail, email_confirm: true });
    if (error) return back(`email=erro&motivo=${/already|registered|exists/i.test(error.message) ? 'em-uso' : 'falha'}`);
    await sendAccountChangeNotice({ to: old, kind: 'email', newEmail: r.newEmail }).catch(() => {});
    return back('email=ok');
  }

  return back('');
};
