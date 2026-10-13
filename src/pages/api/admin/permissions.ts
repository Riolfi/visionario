import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deletePermission, savePermission } from '../../../lib/repo/roles';

/**
 * POST /api/admin/permissions — grupos de regras por tela (só o Dono).
 *   acao=salvar   id (vazio = nova), screen, name, description, rules[]
 *   acao=excluir  id
 */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  const screen = String(form.get('screen') || '');
  const result =
    acao === 'salvar'
      ? await savePermission({
          id: id || undefined,
          screen,
          name: String(form.get('name') || ''),
          description: String(form.get('description') || ''),
          rules: form.getAll('rules').map(String),
        })
      : acao === 'excluir' && id
        ? await deletePermission(id)
        : ({ ok: false, error: 'Ação inválida.' } as const);
  setFlash(cookies, result.ok ? 'ok' : 'erro', result.ok ? (acao === 'excluir' ? 'Permissão excluída.' : 'Permissão salva.') : result.error);
  return redirect(`/admin/permissoes${screen ? `#tela-${screen}` : ''}`);
};
