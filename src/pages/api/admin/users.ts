import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { createMember, removeMember, setMemberActive, updateMember } from '../../../lib/repo/team';
import { getOwnerEmail, isProprietor, requestOwnerTransfer } from '../../../lib/repo/owner';
import { consumeCode } from '../../../lib/repo/email-codes';
import { supabaseAdmin } from '../../../lib/supabase';

/**
 * POST /api/admin/users — equipe do painel (regra equipe.gerenciar, ver
 * canAccess). As travas contra escalada de privilégio ficam em repo/team.
 *   acao=criar    name, email, password, role_id, is_active
 *   acao=editar   id, name, email, password (opcional), role_id, is_active
 *   acao=excluir  id
 *   acao=ativo    id, ativo=1|0 (botão da lista)
 *   acao=pedir_codigo_proprietario  id → código ao e-mail do Proprietário atual
 *     (passar a posse para esse Administrador; nada é salvo ainda)
 *   acao=editar + proprietario=on + codigo_proprietario → confere o código e só
 *     então salva o usuário e passa a posse
 * A tela de criar/editar pede JSON (fetch) para não perder o que foi digitado
 * num erro; sem isso, redireciona com aviso.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const actor = { ...locals.admin!, userId: locals.user!.id, email: locals.user!.email };
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  // Nome (uma palavra) + Sobrenome viram o nome completo
  const nome = String(form.get('nome') ?? '').trim();
  const sobrenome = String(form.get('sobrenome') ?? '').trim().replace(/\s+/g, ' ');
  const input = {
    name: (form.has('nome') ? [nome, sobrenome].filter(Boolean).join(' ') : String(form.get('name') || '').trim()).slice(0, 120),
    email: String(form.get('email') || ''),
    password: String(form.get('password') || ''),
    roleId: String(form.get('role_id') || ''),
    isActive: form.get('is_active') === 'on',
    notify: form.get('avisar_senha') === 'on',
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const emailOf = async (userId: string) =>
    ((await supabaseAdmin()?.auth.admin.getUserById(userId))?.data.user?.email ?? '').toLowerCase();

  // passar a posse: primeiro só o código (ao e-mail do Proprietário atual); salvar vem depois
  if (acao === 'pedir_codigo_proprietario' && id) {
    const t = await requestOwnerTransfer(actor, await emailOf(id));
    return json(t, t.ok ? 200 : 400);
  }

  if ((acao === 'criar' || acao === 'editar') && form.has('nome') && (!nome || /\s/.test(nome))) {
    const error = 'Nome: escreva uma palavra só (o resto vai em Sobrenome).';
    return wantsJson
      ? new Response(JSON.stringify({ ok: false, error }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } })
      : (setFlash(cookies, 'erro', error), redirect(id ? `/admin/usuarios/equipe/${id}` : '/admin/usuarios/equipe/novo'));
  }

  // editar passando a posse: o código vem antes de gravar qualquer coisa
  const transfer = acao === 'editar' && !!id && form.get('proprietario') === 'on';
  let transferTo = '';
  if (transfer) {
    const target = await emailOf(id);
    if (target && target !== (await getOwnerEmail())) {
      if (!(await isProprietor(actor.email))) return json({ ok: false, error: 'Só o Proprietário pode passar a posse.' }, 403);
      const code = await consumeCode(actor.userId, 'owner', String(form.get('codigo_proprietario') || ''));
      if (!code.ok) return json(code, 400);
      if (code.newEmail !== target) return json({ ok: false, error: 'O código não é desta pessoa. Peça outro.' }, 400);
      // não troca o e-mail no mesmo salvar em que passa a posse
      input.email = target;
      transferTo = target;
    }
  }

  const result =
    acao === 'criar'
      ? await createMember(actor, input)
      : acao === 'editar' && id
        ? await updateMember(actor, id, input)
        : acao === 'excluir' && id
          ? await removeMember(actor, id)
          : acao === 'ativo' && id
            ? await setMemberActive(actor, id, form.get('ativo') === '1')
            : ({ ok: false, error: 'Ação inválida.' } as const);

  // usuário salvo com o código certo: agora sim passa a posse
  if (result.ok && transferTo) {
    const { error } = (await supabaseAdmin()?.from('admin_roles').update({ owner_email: transferTo }).eq('is_owner', true)) ?? { error: null };
    if (error) return json({ ok: false, error: `Usuário salvo, mas o Proprietário não mudou: ${error.message}` }, 500);
    setFlash(cookies, 'ok', `Usuário salvo. ${transferTo} agora é o Proprietário.`);
    return json({ ...result, ok: true });
  }
  const needsToken = false;

  if (result.ok && !needsToken) setFlash(cookies, 'ok', result.message ?? 'Pronto.');
  if (wantsJson) {
    return new Response(JSON.stringify({ ...result, needsToken }), {
      status: result.ok ? 200 : 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!result.ok) setFlash(cookies, 'erro', result.error);
  if ((acao === 'excluir' && result.ok) || acao === 'ativo') return redirect('/admin/usuarios?aba=equipe');
  return redirect(id ? `/admin/usuarios/equipe/${id}` : '/admin/usuarios?aba=equipe');
};
