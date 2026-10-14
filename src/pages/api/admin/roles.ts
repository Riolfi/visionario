import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { deleteRole, saveRole } from '../../../lib/repo/roles';
import { confirmOwnerTransfer, getOwnerEmail, requestOwnerTransfer } from '../../../lib/repo/owner';

/**
 * POST /api/admin/roles — cargos (Administrador ou regra cargos.editar; as
 * travas contra escalada ficam em repo/roles).
 *   acao=salvar      id (vazio = novo), name, description, permissions[], is_active
 *                    + owner_email no cargo Administrador: se mudou, manda o
 *                    código ao Proprietário atual e responde { needsToken }
 *   acao=confirmar_proprietario  code → grava o novo Proprietário
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

  if (acao === 'confirmar_proprietario') {
    const r = await confirmOwnerTransfer(actor, String(form.get('code') || ''));
    if (r.ok) setFlash(cookies, 'ok', `Proprietário alterado para ${r.newEmail}.`);
    return json(r, r.ok ? 200 : 400);
  }

  if (acao !== 'salvar') return redirect('/admin/cargos');

  const r = await saveRole(actor, {
    id: id || undefined,
    name: String(form.get('name') || ''),
    description: String(form.get('description') || ''),
    permissionIds: form.getAll('permissions').map(String),
    is_active: form.get('is_active') === 'on',
  });

  // Proprietário (só vem no cargo Administrador): mudou → código ao e-mail atual
  let needsToken = false;
  if (r.ok && form.has('owner_email')) {
    const wanted = String(form.get('owner_email') || '').trim().toLowerCase();
    if (!wanted) return json({ ok: false, error: 'O Proprietário não pode ficar em branco.' }, 400);
    if (wanted !== (await getOwnerEmail())) {
      const t = await requestOwnerTransfer(actor, wanted);
      if (!t.ok) return json({ ok: false, error: `Cargo salvo, mas o Proprietário não mudou: ${t.error}` }, 400);
      needsToken = true;
    }
  }

  if (r.ok && !needsToken) setFlash(cookies, 'ok', 'Cargo salvo com sucesso!');
  if (wantsJson) return json({ ...r, needsToken }, r.ok ? 200 : 400);
  if (!r.ok) setFlash(cookies, 'erro', r.error);
  // fica na tela de edição (cadastro novo vai para a edição dele)
  return redirect(r.ok ? `/admin/cargos/${r.id}` : id ? `/admin/cargos/${id}` : '/admin/cargos/novo');
};
