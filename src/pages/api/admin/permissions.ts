import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deletePermission, savePermission } from '../../../lib/repo/roles';

/**
 * POST /api/admin/permissions — grupos de regras (só o Dono).
 *   acao=salvar   id (vazio = nova), name, description, rules[]
 *   acao=excluir  id (recusa se algum cargo usa)
 */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const acao = String(form.get('acao') || '');
  const id = String(form.get('id') || '');
  // a tela salva por fetch (pede JSON) para não perder o que foi digitado num erro
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');

  if (acao === 'excluir' && id) {
    const r = await deletePermission(id);
    setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Permissão excluída.' : r.error);
    return redirect(r.ok ? '/admin/permissoes' : `/admin/permissoes/${id}`);
  }
  if (acao !== 'salvar') return redirect('/admin/permissoes');

  const r = await savePermission({
    id: id || undefined,
    name: String(form.get('name') || ''),
    description: String(form.get('description') || ''),
    rules: form.getAll('rules').map(String),
    is_active: form.get('is_active') === 'on',
  });
  if (r.ok) setFlash(cookies, 'ok', 'Permissão salva com sucesso!');
  if (wantsJson) {
    return new Response(JSON.stringify(r), {
      status: r.ok ? 200 : 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (!r.ok) setFlash(cookies, 'erro', r.error);
  // fica na tela de edição (cadastro novo vai para a edição dele)
  return redirect(r.ok ? `/admin/permissoes/${r.id}` : id ? `/admin/permissoes/${id}` : '/admin/permissoes/nova');
};
