import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { createMember, removeMember, setMemberActive, updateMember } from '../../../lib/repo/team';
import { confirmOwnerTransfer, getOwnerEmail, requestOwnerTransfer } from '../../../lib/repo/owner';

/**
 * POST /api/admin/users — equipe do painel (regra equipe.gerenciar, ver
 * canAccess). As travas contra escalada de privilégio ficam em repo/team.
 *   acao=criar    name, email, password, role_id, is_active
 *   acao=editar   id, name, email, password (opcional), role_id, is_active
 *   acao=excluir  id
 *   acao=ativo    id, ativo=1|0 (botão da lista)
 *   proprietario=on (criar/editar um Administrador): passa o Proprietário para
 *     essa pessoa — manda um código ao Proprietário atual e responde { needsToken }
 *   acao=confirmar_proprietario  code → efetiva a troca
 * A tela de criar/editar pede JSON (fetch) para não perder o que foi digitado
 * num erro; sem isso, redireciona com aviso.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const actor = { ...locals.admin!, userId: locals.user!.id, email: locals.user!.email };
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const input = {
    name: String(form.get('name') || '').trim().slice(0, 120),
    email: String(form.get('email') || ''),
    password: String(form.get('password') || ''),
    roleId: String(form.get('role_id') || ''),
    isActive: form.get('is_active') === 'on',
    notify: form.get('avisar_senha') === 'on',
  };

  if (acao === 'confirmar_proprietario') {
    const r = await confirmOwnerTransfer(actor, String(form.get('code') || ''));
    if (r.ok) setFlash(cookies, 'ok', `Proprietário transferido para ${r.newEmail}.`);
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
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

  // Proprietário ligado nesta pessoa (e ela ainda não é): código ao Proprietário atual
  let needsToken = false;
  if (result.ok && (acao === 'criar' || acao === 'editar') && form.get('proprietario') === 'on') {
    const target = input.email.trim().toLowerCase();
    if (target && target !== (await getOwnerEmail())) {
      const t = await requestOwnerTransfer(actor, target);
      if (!t.ok) {
        const error = `Usuário salvo, mas o Proprietário não mudou: ${t.error}`;
        if (wantsJson) return new Response(JSON.stringify({ ok: false, error, id: result.id }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
        setFlash(cookies, 'erro', error);
        return redirect(`/admin/usuarios/equipe/${result.id ?? id}`);
      }
      needsToken = true;
    }
  }

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
