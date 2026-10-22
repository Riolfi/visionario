import type { APIRoute } from 'astro';
import { sendAccountChangeNotice } from '../../../lib/email';
import { uploadImage } from '../../../lib/storage';
import { passwordMatches } from '../../../lib/password-check';
import { supabaseAdmin } from '../../../lib/supabase';
import { getOwnerEmail, isProprietor } from '../../../lib/repo/owner';
import { consumeCode, issueCode } from '../../../lib/repo/email-codes';

/**
 * POST /api/admin/profile — perfil de quem está logado no painel (qualquer
 * membro da equipe; o middleware já garantiu que é admin). Formulário HTML:
 * volta para /admin/perfil com ?ok=… ou ?erro=….
 *   acao=perfil      (tela Meu perfil, JSON) full_name, phone, email, nova,
 *                    confirmar, senha_atual — salva tudo; e-mail novo pede código
 *   acao=dados       full_name, phone
 *   acao=email       email, senha_atual → manda um código ao e-mail ATUAL
 *   acao=email-codigo code → confere o código e só então troca o e-mail
 *   acao=senha       senha_atual, nova, confirmar
 *   acao=sair-todos  encerra a sessão em todos os aparelhos
 */

const back = (redirect: (url: string) => Response, key: 'ok' | 'erro', code: string) =>
  redirect(`/admin/perfil?${key}=${code}`);


export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  const admin = supabaseAdmin();
  if (!user || !admin) return redirect('/entrar');

  const form = await request.formData();
  const acao = String(form.get('acao') || '');

  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  // ---- tela Meu perfil (igual à de editar usuário): tudo de uma vez ----
  if (acao === 'perfil') {
    // Nome (uma palavra) + Sobrenome viram o nome completo
    const nome = String(form.get('nome') ?? '').trim();
    const sobrenome = String(form.get('sobrenome') ?? '').trim().replace(/\s+/g, ' ');
    if (form.has('nome') && (!nome || /\s/.test(nome))) return json({ ok: false, error: 'Nome: escreva uma palavra só (o resto vai em Sobrenome).' }, 400);
    const full_name = (form.has('nome') ? [nome, sobrenome].filter(Boolean).join(' ') : String(form.get('full_name') || '').trim()).slice(0, 120);
    const phone = String(form.get('phone') || '').replace(/[^\d+()\s-]/g, '').trim().slice(0, 30);
    const email = String(form.get('email') || '').trim().toLowerCase();
    const nova = String(form.get('nova') || '');
    const senhaAtual = String(form.get('senha_atual') || '');
    const emailChanged = !!email && email !== (user.email ?? '').toLowerCase();
    if (full_name.length < 2) return json({ ok: false, error: 'Informe o nome (mínimo 2 letras).' }, 400);
    if (emailChanged && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'E-mail inválido.' }, 400);
    if (nova && nova.length < 8) return json({ ok: false, error: 'A nova senha precisa ter pelo menos 8 caracteres.' }, 400);
    if (nova && nova !== String(form.get('confirmar') || '')) return json({ ok: false, error: 'A confirmação não bate com a nova senha.' }, 400);
    // trocar e-mail ou senha pede a senha atual
    if ((emailChanged || nova) && !(await passwordMatches(user.email ?? '', senhaAtual))) {
      return json({ ok: false, error: 'Senha atual incorreta (precisa dela para trocar e-mail ou senha).' }, 400);
    }
    if (emailChanged && email === (await getOwnerEmail())) return json({ ok: false, error: 'Esse e-mail já é usado por outra conta.' }, 400);

    const { error: e1 } = await admin.from('profiles').upsert({ id: user.id, full_name, phone }, { onConflict: 'id' });
    if (e1) return json({ ok: false, error: 'Não foi possível salvar. Tente de novo.' }, 500);
    if (nova) {
      const { error } = await admin.auth.admin.updateUserById(user.id, { password: nova });
      if (error) return json({ ok: false, error: 'Dados salvos, mas a senha não foi trocada. Tente de novo.' }, 500);
      await sendAccountChangeNotice({ to: user.email ?? '', name: full_name, kind: 'senha' }).catch(() => {});
    }
    if (emailChanged) {
      // a troca só vale com o código enviado ao e-mail atual (sessão roubada não troca o e-mail)
      const sent = await issueCode({
        userId: user.id,
        purpose: 'email',
        newEmail: email,
        sendTo: user.email ?? '',
        subject: 'Código para trocar o seu e-mail',
        intro: `Foi pedida a troca do e-mail da sua conta para ${email}.`,
      });
      if (!sent.ok) return json({ ok: false, error: `Dados salvos, mas o e-mail não mudou: ${sent.error}` }, 400);
      return json({ ok: true, needsCode: true });
    }
    return json({ ok: true });
  }

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
    if (email === (await getOwnerEmail())) return back(redirect, 'erro', 'email-em-uso');
    if (!(await passwordMatches(user.email ?? '', String(form.get('senha_atual') || '')))) {
      return back(redirect, 'erro', 'senha-atual');
    }
    // a troca só vale com o código enviado ao e-mail atual (sessão roubada não troca o e-mail)
    const sent = await issueCode({
      userId: user.id,
      purpose: 'email',
      newEmail: email,
      sendTo: user.email ?? '',
      subject: 'Código para trocar o seu e-mail',
      intro: `Foi pedida a troca do e-mail da sua conta para ${email}.`,
    });
    if (!sent.ok) return back(redirect, 'erro', /RESEND/.test(sent.error) ? 'sem-envio' : /migration/.test(sent.error) ? 'migration' : 'envio');
    return back(redirect, 'ok', 'codigo-email');
  }

  if (acao === 'email-codigo') {
    const r = await consumeCode(user.id, 'email', String(form.get('code') || ''));
    if (!r.ok) {
      if (wantsJson) return json(r, 400);
      return back(redirect, 'erro', /expirou/.test(r.error) ? 'codigo-expirou' : /Nenhum|tentativas/.test(r.error) ? 'codigo-novo' : 'codigo');
    }
    const proprietor = await isProprietor(user.email);
    if (!proprietor && r.newEmail === (await getOwnerEmail())) {
      return wantsJson ? json({ ok: false, error: 'Esse e-mail já é usado por outra conta.' }, 400) : back(redirect, 'erro', 'email-em-uso');
    }
    // admin API: troca direto (o código já provou o pedido)
    const { error } = await admin.auth.admin.updateUserById(user.id, { email: r.newEmail, email_confirm: true });
    if (error) {
      const inUse = /already|registered|exists/i.test(error.message);
      return wantsJson ? json({ ok: false, error: inUse ? 'Esse e-mail já é usado por outra conta.' : 'Não foi possível trocar o e-mail.' }, 400) : back(redirect, 'erro', inUse ? 'email-em-uso' : 'falha');
    }
    // o Proprietário que troca o próprio e-mail continua Proprietário (com o e-mail novo)
    if (proprietor) await admin.from('admin_roles').update({ owner_email: r.newEmail }).eq('is_owner', true);
    // aviso ao e-mail antigo
    await sendAccountChangeNotice({ to: user.email ?? '', kind: 'email', newEmail: r.newEmail }).catch(() => {});
    return wantsJson ? json({ ok: true }) : back(redirect, 'ok', 'email');
  }

  if (acao === 'senha') {
    const nova = String(form.get('nova') || '');
    if (nova.length < 8) return back(redirect, 'erro', 'senha-curta');
    if (nova !== String(form.get('confirmar') || '')) return back(redirect, 'erro', 'senha-diferente');
    if (!(await passwordMatches(user.email ?? '', String(form.get('senha_atual') || '')))) {
      return back(redirect, 'erro', 'senha-atual');
    }
    const { error } = await admin.auth.admin.updateUserById(user.id, { password: nova });
    if (!error) await sendAccountChangeNotice({ to: user.email ?? '', kind: 'senha' }).catch(() => {});
    return error ? back(redirect, 'erro', 'falha') : back(redirect, 'ok', 'senha');
  }

  // foto do perfil (aparece no cabeçalho do painel); fica em user_metadata.avatar_url
  if (acao === 'foto' || acao === 'remover-foto') {
    let avatar = '';
    if (acao === 'foto') {
      const file = form.get('foto');
      if (!(file instanceof File) || !file.size) return back(redirect, 'erro', 'foto');
      const up = await uploadImage(file, 'avatars', { maxBytes: 2 * 1024 * 1024, allowedTypes: ['image/jpeg', 'image/png', 'image/webp'] });
      if ('error' in up) return back(redirect, 'erro', 'foto');
      avatar = up.url;
    }
    const { data: u } = await admin.auth.admin.getUserById(user.id);
    const { error } = await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...(u.user?.user_metadata ?? {}), avatar_url: avatar || null } });
    return error ? back(redirect, 'erro', 'foto') : back(redirect, 'ok', acao === 'foto' ? 'foto' : 'sem-foto');
  }

  if (acao === 'sair-todos') {
    await locals.supabase?.auth.signOut({ scope: 'global' });
    return redirect('/entrar');
  }

  return back(redirect, 'erro', 'falha');
};
