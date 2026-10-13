import type { APIRoute } from 'astro';
import { changeOrderStatus } from '../../../lib/repo/orders';
import { sendOrderStatusEmail } from '../../../lib/email';
import { ORDER_STATUS_LABELS, type OrderStatus } from '../../../lib/types';

const VALID = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const orderNumber = String(form.get('order_number') || '').trim();
  const status = String(form.get('status') || '') as OrderStatus;
  const trackingCode = String(form.get('tracking_code') || '').trim();
  const notify = form.get('notify') !== 'off';

  if (!orderNumber || !VALID.includes(status)) {
    return redirect(`/admin/pedidos/${orderNumber}?erro=1`);
  }

  const { order, error } = await changeOrderStatus(orderNumber, status, {
    trackingCode: status === 'shipped' ? trackingCode : undefined,
  });

  if (!order) {
    // falta de estoque ao marcar como pago: mostra o motivo
    const estoque = error && /estoque/i.test(error) ? '&motivo=estoque' : '';
    return redirect(`/admin/pedidos/${orderNumber}?erro=update${estoque}`);
  }

  if (notify) {
    await sendOrderStatusEmail(order, status).catch((e) =>
      console.error('[admin/orders] e-mail falhou:', e),
    );
  }

  return redirect(`/admin/pedidos/${orderNumber}?ok=1`);
};
