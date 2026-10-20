import type { APIRoute } from 'astro';
import { CANCEL_REASONS_CAIXA, joinReason } from '../../../lib/types';
import {
  createCaixaSale,
  cancelCaixaSale,
  createCaixaPixOrder,
  recordCancellation,
  getOrderByNumber,
  setOrderStatus,
} from '../../../lib/repo/orders';
import { getPaymentStatus, hasMercadoPago, processPayment } from '../../../lib/mercadopago';
import { fulfillPaidOrder } from '../../../lib/fulfillment';
import type { Order, PaymentMethod } from '../../../lib/types';
import { can } from '../../../lib/rbac';
import { getProductById } from '../../../lib/repo/catalog';
import { parseParts, splitError } from '../../../lib/payments';

/**
 * POST /api/admin/caixa
 *  - { items: [{ product_id, quantity }], method }  → finaliza a venda (dinheiro/cartão)
 *  - { items, method: 'misto', payments }           → idem, pagamento combinado sem Pix
 *  - { action: 'pix_charge', items }                → gera uma cobrança Pix real p/ os itens
 *  - { action: 'pix_charge', items, payments }      → combinado com Pix: cria o pedido e cobra o 1º Pix
 *  - { action: 'pix_split', order_number, payment_ids } → confere os Pix pagos e cobra o próximo
 *                                                     (fecha a venda quando todos foram pagos)
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

/**
 * Pix de um pagamento combinado: cada parte Pix é uma cobrança própria, com
 * referência `<pedido>:pixN` (o webhook não acha pedido com esse número e
 * ignora). Quem fecha a venda é o Caixa, chamando isto enquanto espera:
 * confere no Mercado Pago os Pix já gerados, cobra o próximo e, com todos
 * pagos, confirma o pedido (baixa o estoque).
 * ponytail: só o Caixa aberto confirma; fechar a tela no meio deixa o pedido pendente.
 */
async function advancePixSplit(order: Order, paymentIds: string[]): Promise<Response> {
  const pix = (order.payments ?? []).filter((p) => p.method === 'pix');
  const ref = (i: number) => `${order.order_number}:pix${i}`;
  if (paymentIds.length > pix.length) return json({ error: 'Pix a mais.' }, 400);

  for (const [i, id] of paymentIds.entries()) {
    if (!hasMercadoPago) continue; // modo demonstração: tudo aprovado
    const st = await getPaymentStatus(id);
    if (!st || st.externalReference !== ref(i)) return json({ error: 'Pix não confere com a venda.' }, 400);
    if (st.status === 'approved') continue;
    if (st.status === 'rejected' || st.status === 'cancelled') return json({ ok: true, state: 'failed' });
    return json({ ok: true, state: 'waiting' });
  }

  if (paymentIds.length < pix.length) {
    const i = paymentIds.length;
    const r = await processPayment(order, { payment_method_id: 'pix' }, { amountCents: pix[i]!.amount_cents, ref: ref(i) });
    if (r.status === 'rejected') return json({ error: r.detail || 'Pix recusado. Tente novamente.' }, 502);
    return json({
      ok: true,
      state: 'charge',
      order_id: order.id,
      order_number: order.order_number,
      total_cents: order.total_cents,
      index: i,
      count: pix.length,
      amount_cents: pix[i]!.amount_cents,
      payment_id: r.paymentId,
      pix: r.pix ?? null,
    });
  }

  await fulfillPaidOrder(order.order_number, { paymentId: paymentIds.join(','), method: 'pix' });
  return json({ ok: true, state: 'done', order_number: order.order_number, total_cents: order.total_cents });
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
      // combinado: valida as partes, cria o pedido e cobra o 1º Pix
      if (body.payments) {
        const payments = parseParts(body.payments);
        const err = splitError(payments, await saleTotal(items));
        if (err) return json({ error: err }, 400);
        if (!payments.some((p) => p.method === 'pix')) return json({ error: 'Pagamento combinado sem Pix.' }, 400);
        return advancePixSplit(await createCaixaPixOrder({ items, payments, operatorId: locals.user?.id }), []);
      }
      const order = await createCaixaPixOrder({ items, operatorId: locals.user?.id });
      const result = await processPayment(order, { payment_method_id: 'pix' });

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

  // --- Pix em partes: confere os pagos, cobra o próximo, fecha no último ---
  if (body.action === 'pix_split') {
    const order = await getOrderByNumber(String(body.order_number || '').trim());
    if (!order || order.source !== 'caixa' || order.payment_method !== 'misto') return json({ error: 'Venda não encontrada.' }, 404);
    if (order.status === 'paid') return json({ ok: true, state: 'done', order_number: order.order_number, total_cents: order.total_cents });
    if (order.status !== 'pending') return json({ ok: true, state: 'failed' });
    const ids = Array.isArray(body.payment_ids) ? body.payment_ids.map(String) : [];
    try {
      return await advancePixSplit(order, ids);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Falha no Pix.' }, 500);
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
    // motivo obrigatório, da lista do Caixa ("Outro" pede detalhe)
    const motivo = String(body.motivo || '');
    const reason = joinReason(motivo, String(body.detalhe || ''));
    if (!CANCEL_REASONS_CAIXA.includes(motivo) || reason.length < 3) return json({ error: 'Escolha o motivo do cancelamento.' }, 400);
    try {
      const outcome = await cancelCaixaSale(orderNumber);
      if (outcome === 'cancelled') await recordCancellation(orderNumber, locals.user?.id ?? null, reason);
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
    // dinheiro (pagamento simples): guarda o valor recebido para mostrar o troco no pedido
    const received = Number(body.received_cents);
    const receivedCents = method === 'cash' && Number.isInteger(received) && received > 0 ? received : null;
    const order = await createCaixaSale({ items, method, payments, operatorId: locals.user?.id, receivedCents });
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
