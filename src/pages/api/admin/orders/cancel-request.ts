import type { APIRoute } from 'astro';
import { getOrderByNumber } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { rejectCancelRequest } from '../../../../lib/order-policy';

/**
 * POST /api/admin/orders/cancel-request — recusa o pedido de cancelamento do
 * cliente (order_number, resposta obrigatória). A resposta vai por e-mail e
 * aparece em Minha conta; o pedido segue normalmente. Aprovar é cancelar
 * (/api/admin/orders/cancel). Regra pedidos.cancelar.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  if (!can(locals.admin, 'pedidos.cancelar')) {
    setFlash(cookies, 'erro', 'Seu cargo não permite analisar cancelamentos.');
    return redirect(back);
  }
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  const response = String(form.get('resposta') || '').trim();
  if (response.length < 5) {
    setFlash(cookies, 'erro', 'Escreva a resposta ao cliente (por que o cancelamento foi recusado).');
    return redirect(back);
  }
  const r = await rejectCancelRequest(order, locals.user?.id ?? null, response);
  setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Pedido de cancelamento recusado. O cliente recebeu a resposta por e-mail.' : r.error);
  return redirect(back);
};
