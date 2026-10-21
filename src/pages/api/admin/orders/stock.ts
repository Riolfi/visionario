import type { APIRoute } from 'astro';
import { getOrderByNumber } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { resolvePendingStock, restockFromForm } from '../../../../lib/order-policy';

/**
 * POST /api/admin/orders/stock — decide o estoque pendente de uma venda
 * cancelada (order_number, restock_<product_id>): essas unidades voltam ao
 * estoque, o resto fica registrado como perda. Regra pedidos.cancelar.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  if (!can(locals.admin, 'pedidos.cancelar')) {
    setFlash(cookies, 'erro', 'Seu cargo não permite mexer no estoque de cancelamentos.');
    return redirect(back);
  }
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  const r = await resolvePendingStock(order, restockFromForm(form), locals.user?.id ?? null);
  setFlash(cookies, r.ok ? 'ok' : 'erro', r.ok ? 'Estoque atualizado: o que não voltou ficou registrado como perda.' : r.error);
  return redirect(back);
};
