import type { APIRoute } from 'astro';
import { changeOrderStatus, getOrderByNumber } from '../../../lib/repo/orders';
import { sendOrderStatusEmail } from '../../../lib/email';
import { hasResend } from '../../../lib/env';
import { isValidEmail } from '../../../lib/format';
import { FINAL_STATUSES, ORDER_NEXT, ORDER_STATUS_LABELS, isValidTracking, normalizeTracking, type OrderStatus } from '../../../lib/types';

const VALID = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];

/**
 * POST /api/admin/orders — muda o status de uma compra online.
 *   order_number, status, tracking_code (Enviado), notify=on (e-mail ao cliente)
 * Só avança na linha do tempo (ORDER_NEXT); Entregue/Cancelado não mudam.
 * Com notify, o e-mail precisa sair: se falhar, a mudança é desfeita.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const orderNumber = String(form.get('order_number') || '').trim();
  const status = String(form.get('status') || '') as OrderStatus;
  const trackingCode = normalizeTracking(String(form.get('tracking_code') || ''));
  // checkbox desmarcado não vem no formulário: só notifica se veio marcado
  const notify = form.get('notify') === 'on';
  const back = (q: string) => redirect(`/admin/pedidos/${orderNumber}?${q}`);

  // cancelar tem fluxo próprio (motivo + pedido do cliente + estorno)
  if (!orderNumber || !VALID.includes(status) || status === 'cancelled') return back('erro=update');
  const current = await getOrderByNumber(orderNumber);
  if (!current) return redirect('/admin/pedidos');
  // venda do Caixa: só Concluída ou Cancelada (pelo botão de cancelar)
  if (current.source === 'caixa') return back('erro=update');
  if (FINAL_STATUSES.includes(current.status)) return back('erro=update&motivo=final');
  // só para frente (o mesmo status vale para trocar o rastreio de um Enviado)
  if (status !== current.status && !ORDER_NEXT[current.status].includes(status)) return back('erro=update&motivo=retrocesso');
  if (status === current.status && status !== 'shipped') return back('erro=update&motivo=igual');
  // Enviado e Entregue exigem rastreio válido
  const withTracking = status === 'shipped' || status === 'delivered';
  if (withTracking && !trackingCode) return back('erro=update&motivo=rastreio');
  if (withTracking && !isValidTracking(trackingCode)) return back('erro=update&motivo=rastreio-invalido');
  // vai avisar: e-mail do cliente precisa ser válido antes de mudar qualquer coisa
  if (notify && !isValidEmail(current.customer_email ?? '')) return back('erro=update&motivo=email-invalido');

  const { order, error } = await changeOrderStatus(orderNumber, status, {
    trackingCode: withTracking ? trackingCode : undefined,
  });
  if (!order) {
    // falta de estoque ao marcar como pago: mostra o motivo
    return back(`erro=update${error && /estoque/i.test(error) ? '&motivo=estoque' : ''}`);
  }

  if (notify) {
    const r = await sendOrderStatusEmail(order, status).catch((e) => {
      console.error('[admin/orders] e-mail falhou:', e);
      return { delivered: 'none' as const };
    });
    // sem Resend configurado (dev), o e-mail vira arquivo e conta como enviado
    const sent = r.delivered === 'resend' || (!hasResend && r.delivered === 'file');
    if (!sent) {
      // e-mail não saiu: desfaz (status e rastreio de antes; o estoque volta junto)
      await changeOrderStatus(orderNumber, current.status, { trackingCode: current.tracking_code ?? '' });
      return back('erro=update&motivo=email');
    }
  }

  return back(`ok=1&email=${notify ? 1 : 0}`);
};
