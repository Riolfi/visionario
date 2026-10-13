import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deleteRole, saveRole } from '../../../lib/repo/roles';

/**
 * POST /api/admin/roles — cargos (só o Dono).
 *   acao=salvar   id (vazio = novo), name, description, permissions[]
 *   acao=excluir  id
 */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const result =
    acao === 'salvar'
      ? await saveRole({
          id: id || undefined,
          name: String(form.get('name') || ''),
          description: String(form.get('description') || ''),
          permissionIds: form.getAll('permissions').map(String),
        })
      : acao === 'excluir' && id
        ? await deleteRole(id)
        : ({ ok: false, error: 'Ação inválida.' } as const);
  setFlash(cookies, result.ok ? 'ok' : 'erro', result.ok ? (acao === 'excluir' ? 'Cargo excluído. Quem tinha esse cargo ficou sem acesso às telas até receber outro.' : 'Cargo salvo.') : result.error);
  return redirect('/admin/cargos');
};
