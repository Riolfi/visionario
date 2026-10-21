import type { APIRoute } from 'astro';
import { getOrderByNumber } from '../../../lib/repo/orders';
import { receiptUrl } from '../../../lib/receipt';
import { json } from '../../../lib/payment-service';

/**
 * GET /api/admin/receipt?order=<número> — link assinado do comprovante e o
 * telefone do cliente (para o WhatsApp), usados na tela de venda concluída
 * do Caixa. Regra: caixa.vender ou pedidos.ver (rbac).
 */
export const GET: APIRoute = async ({ url }) => {
  const order = await getOrderByNumber(String(url.searchParams.get('order') || '').trim());
  if (!order || order.status === 'pending' || order.status === 'failed') return json({ error: 'Venda não encontrada.' }, 404);
  return json({ url: receiptUrl(order), phone: order.customer_phone ?? '' });
};
