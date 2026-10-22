import type { APIRoute } from 'astro';
import { sendAccountChangeNotice } from '../../../lib/email';
import { supabaseAdmin } from '../../../lib/supabase';
import { listAuthUsers } from '../../../lib/repo/customers';
import { consumeCode, issueCode } from '../../../lib/repo/email-codes';

/**
 * POST /api/auth/esqueci-senha
 *   acao=pedir   email → manda um código de 6 dígitos para esse e-mail (se a
 *                conta existir; a resposta é a mesma nos dois casos, para não
 *                revelar quem tem conta)
 *   acao=trocar  email, code, nova, confirmar → código certo grava a senha nova
 */
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const email = String(form.get('email') || '').trim().toLowerCase();
  // criar=1: veio do convite da equipe (conta sem senha) — só muda os textos
  const criar = form.get('criar') === '1';
  const extra = criar ? '&criar=1' : '';
  const back = (q: string) => redirect(`/esqueci-senha?${q}${extra}&email=${encodeURIComponent(email)}`);
  if (!isEmail(email)) return redirect(`/esqueci-senha?erro=email${extra}`);
  const user = (await listAuthUsers()).find((u) => u.email?.toLowerCase() === email);

  if (acao === 'pedir') {
    if (user) {
      const r = await issueCode({
        userId: user.id,
        purpose: 'reset',
        newEmail: email,
        sendTo: email,
        subject: criar ? 'Código para criar a sua senha' : 'Código para criar uma nova senha',
        intro: criar
          ? 'Use o código abaixo na página "Criar senha" para criar a senha da sua conta.'
          : 'Foi pedida uma nova senha para a sua conta. Use o código abaixo na página "Esqueci minha senha".',
      });
      // falha de configuração aparece (não revela conta: só acontece com conta existente,
      // mas é erro do servidor, não "conta inexistente")
      if (!r.ok) return back('erro=envio');
    }
    return back('etapa=codigo');
  }

  if (acao === 'trocar') {
    const nova = String(form.get('nova') || '');
    if (nova.length < 8) return back('etapa=codigo&erro=curta');
    if (nova !== String(form.get('confirmar') || '')) return back('etapa=codigo&erro=diferente');
    if (!user) return back('etapa=codigo&erro=codigo');
    const r = await consumeCode(user.id, 'reset', String(form.get('code') || ''));
    if (!r.ok) return back(`etapa=codigo&erro=${/expirou|Nenhum|tentativas/.test(r.error) ? 'codigo-novo' : 'codigo'}`);
    const admin = supabaseAdmin();
    const { error } = admin
      ? await admin.auth.admin.updateUserById(user.id, {
          password: nova,
          // quem escolheu a senha foi a própria pessoa: não precisa trocar de novo
          app_metadata: { ...user.app_metadata, must_change_password: false },
        })
      : { error: new Error('sem supabase') };
    if (error) return back('etapa=codigo&erro=falha');
    // aviso ao dono do e-mail (se não foi ele, sabe na hora)
    await sendAccountChangeNotice({ to: email, kind: 'senha' }).catch(() => {});
    return redirect('/entrar?ok=senha');
  }

  return redirect('/esqueci-senha');
};
