import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deleteRole, saveRole } from '../../../lib/repo/roles';

/**
 * POST /api/admin/roles — cargos (Administrador ou regra cargos.editar; as
 * travas contra escalada ficam em repo/roles).
 *   acao=salvar      id (vazio = novo), name, description, permissions[], is_active
 *   (o Proprietário é trocado na tela do usuário: /api/admin/users)
 *   acao=excluir     id (recusa o Administrador e cargo com pessoas)
 * A tela pede JSON (fetch); sem isso, redireciona com aviso.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const actor = { ...locals.admin!, userId: locals.user!.id, email: locals.user!.email };
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  if (acao === 'excluir' && id) {
    const r = await deleteRole(actor, id);
    setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Cargo excluído.' : r.error);
    return redirect(r.ok ? '/admin/cargos' : `/admin/cargos/${id}`);
  }

  if (acao !== 'salvar') return redirect('/admin/cargos');

  const r = await saveRole(actor, {
    id: id || undefined,
    name: String(form.get('name') || ''),
    description: String(form.get('description') || ''),
    permissionIds: form.getAll('permissions').map(String),
    is_active: form.get('is_active') === 'on',
  });

  if (r.ok) setFlash(cookies, 'ok', 'Cargo salvo com sucesso!');
  if (wantsJson) return json(r, r.ok ? 200 : 400);
  if (!r.ok) setFlash(cookies, 'erro', r.error);
  // fica na tela de edição (cadastro novo vai para a edição dele)
  return redirect(r.ok ? `/admin/cargos/${r.id}` : id ? `/admin/cargos/${id}` : '/admin/cargos/novo');
};
