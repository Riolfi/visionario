import type { APIRoute } from 'astro';
import {
  createCaixaSale,
  cancelCaixaSale,
  createCaixaPixOrder,
  getOrderByNumber,
  setOrderStatus,
} from '../../../lib/repo/orders';
import { processPayment } from '../../../lib/mercadopago';
import { fulfillPaidOrder } from '../../../lib/fulfillment';
import type { PaymentMethod } from '../../../lib/types';
import { can } from '../../../lib/rbac';
import { getProductById } from '../../../lib/repo/catalog';
import { parseParts, splitError } from '../../../lib/payments';

/**
 * POST /api/admin/caixa
 *  - { items: [{ product_id, quantity }], method }  → finaliza a venda (dinheiro/cartão)
 *  - { items, method: 'misto', payments }           → idem, pagamento combinado sem Pix
 *  - { action: 'pix_charge', items, payments? }     → gera uma cobrança Pix real p/ os itens
 *                                                     (com payments: só a parte do Pix)
 *  - { action: 'cancel_pix', order_number }         → desiste de um Pix ainda não pago
 *  - { action: 'cancel', order_number }             → cancela venda já paga e devolve estoque
 *
 * Protegido pelo middleware (/api/admin exige sessão de admin).
 */

const METHODS: PaymentMethod[] = ['cash', 'pix', 'debit_card', 'credit_card'];

/** Total da venda pelo preço do catálogo (o mesmo que a RPC cobra). */
async function saleTotal(items: { product_id: string; quantity: number }[]): Promise<number> {
  let total = 0;
  for (const i of items) {
    const p = await getProductById(i.product_id);
    if (!p) throw new Error('Produto não encontrado no catálogo.');
    total += p.price_cents * Math.max(1, Math.floor(i.quantity));
  }
  return total;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Corpo inválido.' }, 400);
  }

  // --- gerar cobrança Pix (venda ainda não fechada — fica pending até confirmar) ---
  if (body.action === 'pix_charge') {
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems
      .map((i) => {
        const it = i as Record<string, unknown>;
        return { product_id: String(it.product_id || ''), quantity: Number(it.quantity) || 0 };
      })
      .filter((i) => i.product_id && i.quantity > 0);
    if (!items.length) return json({ error: 'Adicione ao menos um item.' }, 400);

    try {
      // combinado: valida as partes e cobra no Pix só a parte dele
      const payments = body.payments ? parseParts(body.payments) : undefined;
      let pixCents: number | undefined;
      if (payments) {
        const err = splitError(payments, await saleTotal(items));
        if (err) return json({ error: err }, 400);
        pixCents = payments.find((p) => p.method === 'pix')?.amount_cents;
        if (!pixCents) return json({ error: 'Pagamento combinado sem Pix.' }, 400);
      }
      const order = await createCaixaPixOrder({ items, payments });
      const result = await processPayment(order, { payment_method_id: 'pix' }, pixCents);

      if (result.status === 'approved' || result.status === 'simulado') {
        await fulfillPaidOrder(order.order_number, { paymentId: result.paymentId, method: 'pix' });
        return json({ ok: true, status: 'approved', order_id: order.id, order_number: order.order_number, total_cents: order.total_cents });
      }

      if (result.status === 'rejected') {
        await setOrderStatus(order.order_number, 'failed');
        return json({ error: result.detail || 'Pix recusado. Tente novamente.' }, 502);
      }

      // pending: aguardando o cliente pagar — webhook/polling confirmam depois
      return json({
        ok: true,
        status: 'pending',
        order_id: order.id,
        order_number: order.order_number,
        total_cents: order.total_cents,
        pix: result.pix ?? null,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Falha ao gerar o Pix.' }, 500);
    }
  }

  // --- desistir de um Pix ainda não pago (mantém os itens no carrinho do caixa) ---
  if (body.action === 'cancel_pix') {
    const orderNumber = String(body.order_number || '').trim();
    if (!orderNumber) return json({ error: 'Pedido não informado.' }, 400);
    const order = await getOrderByNumber(orderNumber);
    if (!order || order.source !== 'caixa') return json({ error: 'Venda não encontrada.' }, 404);
    if (order.status === 'paid') return json({ error: 'Esse Pix já foi pago — não dá pra cancelar.' }, 409);
    if (order.status !== 'cancelled') await setOrderStatus(orderNumber, 'cancelled');
    return json({ ok: true });
  }

  // --- cancelar venda já paga (devolve estoque) ---
  if (body.action === 'cancel') {
    if (!can(locals.admin, 'caixa.cancelar')) return json({ error: 'Seu cargo não permite cancelar vendas.' }, 403);
    const orderNumber = String(body.order_number || '').trim();
    if (!orderNumber) return json({ error: 'Pedido não informado.' }, 400);
    try {
      const outcome = await cancelCaixaSale(orderNumber);
      if (outcome === 'not_found') return json({ error: 'Venda não encontrada.' }, 404);
      if (outcome === 'not_caixa') return json({ error: 'Esse pedido não é do Caixa.' }, 400);
      return json({ ok: true, outcome });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Falha ao cancelar.' }, 500);
    }
  }

  // --- finalizar venda ---
  const method = String(body.method || '') as PaymentMethod;
  if (!METHODS.includes(method) && method !== 'misto') return json({ error: 'Forma de pagamento inválida.' }, 400);

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map((i) => {
      const it = i as Record<string, unknown>;
      return { product_id: String(it.product_id || ''), quantity: Number(it.quantity) || 0 };
    })
    .filter((i) => i.product_id && i.quantity > 0);
  if (!items.length) return json({ error: 'Adicione ao menos um item.' }, 400);

  try {
    let payments;
    if (method === 'misto') {
      payments = parseParts(body.payments);
      if (payments.some((p) => p.method === 'pix')) return json({ error: 'Pix combinado gera cobrança: use pix_charge.' }, 400);
      const err = splitError(payments, await saleTotal(items));
      if (err) return json({ error: err }, 400);
    }
    const order = await createCaixaSale({ items, method, payments });
    return json({
      ok: true,
      order_number: order.order_number,
      total_cents: order.total_cents,
      items: order.items.map((i) => ({
        name: i.product_name,
        quantity: i.quantity,
        unit_price_cents: i.unit_price_cents,
      })),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Falha ao registrar a venda.' }, 500);
  }
};
