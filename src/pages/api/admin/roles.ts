import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deleteRole, saveRole } from '../../../lib/repo/roles';

/**
 * POST /api/admin/roles — cargos (só o Dono).
 *   acao=salvar   id (vazio = novo), name, description, permissions[]
 *   acao=excluir  id (recusa se alguém tem o cargo)
 */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');

  if (acao === 'excluir' && id) {
    const r = await deleteRole(id);
    setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Cargo excluído.' : r.error);
    return redirect(r.ok ? '/admin/cargos' : `/admin/cargos/${id}`);
  }
  if (acao !== 'salvar') return redirect('/admin/cargos');

  const r = await saveRole({
    id: id || undefined,
    name: String(form.get('name') || ''),
    description: String(form.get('description') || ''),
    permissionIds: form.getAll('permissions').map(String),
  });
  setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Cargo salvo com sucesso!' : r.error);
  // fica na tela de edição (cadastro novo vai para a edição dele)
  return redirect(r.ok ? `/admin/cargos/${r.id}` : id ? `/admin/cargos/${id}` : '/admin/cargos/novo');
};
