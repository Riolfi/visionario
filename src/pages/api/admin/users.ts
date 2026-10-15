import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { createMember, removeMember, setMemberActive, updateMember } from '../../../lib/repo/team';

/**
 * POST /api/admin/users — equipe do painel (regra equipe.gerenciar, ver
 * canAccess). As travas contra escalada de privilégio ficam em repo/team.
 *   acao=criar    name, email, password, role_id, is_active
 *   acao=editar   id, name, email, password (opcional), role_id, is_active
 *   acao=excluir  id
 *   acao=ativo    id, ativo=1|0 (botão da lista)
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
  };

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

  if (result.ok) setFlash(cookies, 'ok', result.message ?? 'Pronto.');
  if (wantsJson) {
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!result.ok) setFlash(cookies, 'erro', result.error);
  if ((acao === 'excluir' && result.ok) || acao === 'ativo') return redirect('/admin/usuarios?aba=equipe');
  return redirect(id ? `/admin/usuarios/equipe/${id}` : '/admin/usuarios?aba=equipe');
};
