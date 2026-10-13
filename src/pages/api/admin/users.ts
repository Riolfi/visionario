import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { createMember, removeMember, updateMember } from '../../../lib/repo/team';

/**
 * POST /api/admin/users — equipe do painel (só o dono: ver canAccess).
 *   acao=criar    name, email, password, role, permissions[]
 *   acao=editar   id, name, email, password (opcional), role, permissions[]
 *   acao=excluir  id
 * Formulário HTML: volta para a aba Equipe com o aviso.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const actor = locals.user!;
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const input = {
    name: String(form.get('name') || '').trim().slice(0, 120),
    email: String(form.get('email') || ''),
    password: String(form.get('password') || ''),
    role: (form.get('role') === 'dono' ? 'dono' : 'equipe') as 'dono' | 'equipe',
    permissions: form.getAll('permissions').map(String),
  };

  const result =
    acao === 'criar'
      ? await createMember(input)
      : acao === 'editar' && id
        ? await updateMember(actor.id, id, input)
        : acao === 'excluir' && id
          ? await removeMember(actor.id, id)
          : ({ ok: false, error: 'Ação inválida.' } as const);

  if (result.ok) setFlash(cookies, 'ok', result.message ?? (acao === 'criar' ? 'Membro criado.' : 'Alterações salvas.'));
  else setFlash(cookies, 'erro', result.error);
  return redirect('/admin/usuarios?aba=equipe');
};
