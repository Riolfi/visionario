import type { APIRoute } from 'astro';
import { cancelCaixaSale, changeOrderStatus, getOrderByNumber } from '../../../../lib/repo/orders';
import { sendOrderStatusEmail } from '../../../../lib/email';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';

/**
 * POST /api/admin/orders/cancel — order_number
 * Cancela a compra e devolve os itens ao estoque (regra pedidos.cancelar).
 * Compra online: avisa o cliente por e-mail. Estorno do pagamento é manual.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  // o middleware já confere; de novo aqui porque é ação destrutiva
  if (!can(locals.admin, 'pedidos.cancelar')) {
    setFlash(cookies, 'erro', 'Seu cargo não permite cancelar compras.');
    return redirect(back);
  }
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  if (order.status === 'cancelled') {
    setFlash(cookies, 'erro', 'Esta compra já está cancelada.');
    return redirect(back);
  }

  try {
    if (order.source === 'caixa') {
      await cancelCaixaSale(number);
    } else {
      const { order: updated, error } = await changeOrderStatus(number, 'cancelled');
      if (!updated) throw new Error(error || 'Falha ao cancelar.');
      await sendOrderStatusEmail(updated, 'cancelled').catch((e) => console.error('[orders/cancel] e-mail falhou:', e));
    }
  } catch (e) {
    setFlash(cookies, 'erro', e instanceof Error ? e.message : 'Não foi possível cancelar a compra.');
    return redirect(back);
  }
  setFlash(cookies, 'ok', 'Compra cancelada. Os itens voltaram ao estoque.');
  return redirect(back);
};
