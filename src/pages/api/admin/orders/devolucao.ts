import type { APIRoute } from 'astro';
import { getOrderByNumber } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { completeReturn } from '../../../../lib/order-policy';

/**
 * POST /api/admin/orders/devolucao — order_number, restock=on (devolver ao
 * estoque). Conclui a devolução pedida pelo cliente depois de receber o
 * produto: estorna, cancela e avisa (regra pedidos.cancelar).
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  if (!can(locals.admin, 'pedidos.cancelar')) {
    setFlash(cookies, 'erro', 'Seu cargo não permite concluir devoluções.');
    return redirect(back);
  }
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');

  const restock = form.get('restock') === 'on';
  const r = await completeReturn(order, locals.user?.id ?? null, restock);
  if (!r.ok) {
    setFlash(cookies, 'erro', r.error);
    return redirect(back);
  }
  const refund = r.refundedCents
    ? r.simulated
      ? ' (pagamento de teste: nada a estornar)'
      : ' O valor foi estornado ao cliente pelo Mercado Pago.'
    : '';
  setFlash(
    cookies,
    'ok',
    `Devolução concluída.${refund} ${restock ? 'Os itens voltaram ao estoque.' : 'Os itens não voltaram ao estoque.'} O cliente foi avisado por e-mail.`,
  );
  return redirect(back);
};
