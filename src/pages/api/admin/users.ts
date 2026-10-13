import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { createMember, removeMember, updateMember } from '../../../lib/repo/team';

/**
 * POST /api/admin/users — equipe do painel (regra equipe.gerenciar, ver
 * canAccess). As travas contra escalada de privilégio ficam em repo/team.
 *   acao=criar    name, email, password, role_id
 *   acao=editar   id, name, email, password (opcional), role_id
 *   acao=excluir  id
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const actor = { ...locals.admin!, userId: locals.user!.id };
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const input = {
    name: String(form.get('name') || '').trim().slice(0, 120),
    email: String(form.get('email') || ''),
    password: String(form.get('password') || ''),
    roleId: String(form.get('role_id') || ''),
  };

  const result =
    acao === 'criar'
      ? await createMember(actor, input)
      : acao === 'editar' && id
        ? await updateMember(actor, id, input)
        : acao === 'excluir' && id
          ? await removeMember(actor, id)
          : ({ ok: false, error: 'Ação inválida.' } as const);

  setFlash(cookies, result.ok ? 'ok' : 'erro', result.ok ? (result.message ?? 'Pronto.') : result.error);
  return redirect('/admin/usuarios?aba=equipe');
};
