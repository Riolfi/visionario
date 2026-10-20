import type { APIRoute } from 'astro';
import { setFlash } from '../../../lib/flash';
import { CUSTOMER_STATUS_REASONS, OTHER_REASON, isCustomerStatus, setCustomerStatus } from '../../../lib/repo/customers';

/**
 * POST /api/admin/customers — estado da conta do cliente (só o dono).
 *   acao=status  id, status (ativo|desativado|bloqueado), motivo (um de
 *                CUSTOMER_STATUS_REASONS[status] ou "outro" + reason escrito)
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  const status = form.get('status');
  const motivo = String(form.get('motivo') || '');
  const back = `/admin/usuarios/clientes/${encodeURIComponent(id)}`;

  if (String(form.get('acao')) !== 'status' || !/^[0-9a-f-]{36}$/i.test(id) || !isCustomerStatus(status)) {
    setFlash(cookies, 'erro', 'Pedido inválido.');
    return redirect('/admin/usuarios?aba=clientes');
  }
  // motivo da lista do estado escolhido, ou "Outro motivo" com o texto escrito
  const reason = motivo === OTHER_REASON ? String(form.get('reason') || '').trim().slice(0, 500) : motivo;
  if (motivo !== OTHER_REASON && !CUSTOMER_STATUS_REASONS[status].includes(motivo)) {
    setFlash(cookies, 'erro', 'Escolha o motivo da mudança.');
    return redirect(back);
  }
  if (reason.length < 3) {
    setFlash(cookies, 'erro', 'Escreva o motivo da mudança.');
    return redirect(back);
  }
  const result = await setCustomerStatus(id, status, reason, locals.user!.id);
  setFlash(cookies, result.ok ? 'ok' : 'erro', result.ok ? 'Estado da conta atualizado.' : result.error);
  return redirect(back);
};
