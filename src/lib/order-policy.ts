/**
 * Política de cancelamento e devolução (compras online e do Caixa).
 *
 *  - Aguardando pagamento/Pago: o cliente cancela sozinho; se já pagou, o
 *    estorno sai na hora pelo Mercado Pago.
 *  - Em separação: o cliente pede a desistência; a equipe é avisada e só
 *    aprova (confirma que parou a separação e decide estoque/perda). Enquanto
 *    o pedido está pendente, a venda não avança para Enviado.
 *  - Enviado: nada pelo site; Entregue abre a troca ou devolução por 7 dias
 *    corridos (CDC, art. 49), contados de delivered_at, em duas etapas
 *    (aprovar com a forma de devolver; concluir quando os itens chegarem).
 *  - A equipe cancela compra online antes do envio com motivo; Caixa, sempre.
 *  - Cancelado é final (o banco também recusa, migration 0025).
 */
import { changeOrderStatus, createExchangeOrder, recordCancellation } from './repo/orders';
import { supabaseAdmin } from './supabase';
import { createNotification } from './repo/notifications';
import { refundPayment } from './mercadopago';
import { sendOrderStatusEmail, sendReturnAnswer } from './email';
import { orderLabel } from './format';
import { PAYMENT_METHOD_LABELS, RECEIVED_STATUSES, type Order, type OrderStatus, type StockLine } from './types';
import { brl } from './format';

// cliente cancela sozinho (com estorno) antes da separação; em separação, só pede a desistência
export const CUSTOMER_CANCELABLE: OrderStatus[] = ['pending', 'paid'];
export const CUSTOMER_REQUEST_CANCEL: OrderStatus[] = ['separating'];
/** a equipe ainda cancela pagamento não concluído; depois de enviado, só devolução */
export const STAFF_CANCELABLE_ONLINE: OrderStatus[] = ['pending', 'paid', 'separating', 'failed'];
export const RETURN_DAYS = 7;

export { CUSTOMER_CANCEL_REASONS, RETURN_REASONS, CANCEL_REASONS_ONLINE, CANCEL_REASONS_CAIXA, joinReason } from './types';

/** Prazo final da devolução (7 dias corridos depois da entrega); null fora de Entregue. */
export function returnDeadline(order: Order): Date | null {
  if (order.status !== 'delivered') return null;
  const base = order.delivered_at ?? order.updated_at;
  return base ? new Date(new Date(base).getTime() + RETURN_DAYS * 86_400_000) : null;
}

/**
 * Tira de novo do estoque itens que o cancelamento devolveu — para produto
 * danificado que não pode voltar à venda.
 * ponytail: ler e gravar por produto (ação rara, de uma pessoa só); se virar gargalo, RPC
 */
export async function withdrawStock(items: Pick<Order['items'][number], 'product_id' | 'quantity'>[]) {
  for (const it of items) await adjustStock(it.product_id, -it.quantity);
}

/** Soma (ou tira, com delta negativo) unidades do estoque de um produto. */
async function adjustStock(productId: string, delta: number) {
  const sb = supabaseAdmin();
  if (!sb || !delta) return;
  const { data } = await sb.from('products').select('stock').eq('id', productId).maybeSingle();
  if (data) await sb.from('products').update({ stock: Math.max(0, data.stock + delta) }).eq('id', productId);
}

/** O estoque já tinha saído? (venda do Caixa concluída ou compra online paga) */
export const stockWasOut = (order: Order) => (order.source === 'caixa' ? order.status === 'paid' : RECEIVED_STATUSES.includes(order.status));

/**
 * Decisão de estoque no cancelamento, por item e quantidade:
 *  - now:   restock[product_id] unidades voltam ao estoque; o resto é perda
 *           (avaria, produto violado ou quebrado);
 *  - later: tudo fica fora do estoque (stock_pending) até a equipe decidir —
 *           ex.: o cliente ainda vai devolver os itens.
 * Chamada DEPOIS do cancelamento, que devolve tudo ao estoque (RPC): aqui só
 * se tira de novo o que não volta.
 */
export type StockDecision = { mode: 'now'; restock: Record<string, number> } | { mode: 'later' };

export function stockLines(order: Order, restock: Record<string, number>): StockLine[] {
  const by = new Map<string, StockLine>();
  for (const it of order.items) {
    const l = by.get(it.product_id) ?? { product_id: it.product_id, product_name: it.product_name, quantity: 0, restocked: 0 };
    l.quantity += it.quantity;
    by.set(it.product_id, l);
  }
  for (const l of by.values()) l.restocked = Math.max(0, Math.min(l.quantity, Math.floor(Number(restock[l.product_id] ?? l.quantity) || 0)));
  return [...by.values()];
}

async function saveStock(orderId: string, patch: Record<string, unknown>) {
  await supabaseAdmin()?.from('orders').update(patch).eq('id', orderId);
}

export async function applyStockDecision(order: Order, decision: StockDecision, by: string | null) {
  if (decision.mode === 'later') {
    await withdrawStock(order.items);
    await saveStock(order.id, { stock_pending: true, stock_resolution: null });
    return;
  }
  const lines = stockLines(order, decision.restock);
  for (const l of lines) await adjustStock(l.product_id, -(l.quantity - l.restocked));
  await saveStock(order.id, { stock_pending: false, stock_resolution: lines, stock_resolved_at: new Date().toISOString(), stock_resolved_by: by });
}

/** Estoque pendente de um cancelamento: devolve as unidades escolhidas; o resto vira perda. */
export async function resolvePendingStock(order: Order, restock: Record<string, number>, by: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (order.status !== 'cancelled' || !order.stock_pending) return { ok: false, error: 'Esta venda não tem estoque pendente.' };
  const lines = stockLines(order, restock);
  for (const l of lines) await adjustStock(l.product_id, l.restocked);
  await saveStock(order.id, { stock_pending: false, stock_resolution: lines, stock_resolved_at: new Date().toISOString(), stock_resolved_by: by });
  return { ok: true };
}

/** Lê "restock_<product_id>" do formulário. */
export function restockFromForm(form: FormData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of form.entries()) if (k.startsWith('restock_')) out[k.slice(8)] = Number(v);
  return out;
}

/** Pedido de cancelamento do cliente esperando análise? */
export const cancelRequestPending = (order: Order) => !!order.cancel_requested_at && !order.cancel_request_resolved_at && order.status !== 'cancelled';

/**
 * Cancela uma compra online: estorna no Mercado Pago se já foi paga (estorno
 * falhou = nada muda), põe Cancelado (o estoque volta se já tinha baixado),
 * grava quem/quando/motivo e avisa o cliente com os dados do reembolso.
 * `by` é o id de quem fez (o próprio cliente ou alguém da equipe).
 */
export async function cancelOnlineOrder(
  order: Order,
  by: string | null,
  reason: string,
  opts: { notify?: boolean; stock?: StockDecision } = {},
): Promise<{ ok: true; refundedCents: number | null; simulated?: boolean } | { ok: false; error: string }> {
  if (!STAFF_CANCELABLE_ONLINE.includes(order.status)) {
    return { ok: false, error: 'Venda já enviada ou finalizada: não dá para cancelar. Para devolver, use a solicitação de devolução.' };
  }
  const paid = RECEIVED_STATUSES.includes(order.status);
  let refundedCents: number | null = null;
  let simulated = false;
  if (paid && order.mp_payment_id) {
    const r = await refundPayment(order.mp_payment_id, order);
    if (!r.ok) return { ok: false, error: r.error };
    refundedCents = order.total_cents;
    simulated = !!r.simulated;
  }
  const { order: updated, error } = await changeOrderStatus(order.order_number, 'cancelled');
  if (!updated) {
    // o dinheiro já voltou, mas o status não mudou: a equipe precisa ver
    if (refundedCents) {
      await createNotification({
        kind: 'cancelamento_falhou',
        message: `O pedido ${orderLabel(order.order_number)} foi estornado, mas não ficou como Cancelado (${error ?? 'erro'}). Cancele de novo no painel.`,
        order_number: order.order_number,
      });
    }
    return { ok: false, error: error || 'Não foi possível cancelar.' };
  }
  // estoque já tinha saído (pago): o que não volta (perda) ou o que espera decisão sai de novo
  if (paid) await applyStockDecision(order, opts.stock ?? { mode: 'now', restock: {} }, by);
  // pedido do cliente em análise: fica aprovado junto com o cancelamento
  if (cancelRequestPending(order)) {
    await supabaseAdmin()?.from('orders').update({ cancel_request_resolved_at: new Date().toISOString(), cancel_request_resolved_by: by, cancel_request_response: 'Cancelamento aprovado.' }).eq('id', order.id);
  }
  await recordCancellation(order.order_number, by, reason);
  if (opts.notify !== false) {
    await sendOrderStatusEmail(updated, 'cancelled', { refundCents: refundedCents }).catch((e) =>
      console.error('[cancel] e-mail falhou:', e),
    );
  }
  return { ok: true, refundedCents, simulated };
}

/** Troca/devolução pedida e ainda não concluída nem recusada. */
export const returnOpen = (order: Order) => !!order.return_requested_at && !order.return_completed_at && !order.return_rejected_at;
/** Etapa 1 pendente: a equipe ainda não aprovou nem recusou. */
export const returnAwaitingReview = (order: Order) => returnOpen(order) && !order.return_approved_at;

async function saveReturn(order: Order, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, error: 'Supabase não configurado.' };
  const { error } = await sb.from('orders').update(patch).eq('id', order.id);
  return error ? { ok: false, error: /return_|exchange_/.test(error.message) ? 'Rode a migration 0030 no Supabase.' : error.message } : { ok: true };
}

/** Etapa 1: aprova e informa como devolver (Correios); o cliente recebe por e-mail e vê em Minha conta. */
export async function approveReturn(order: Order, by: string | null, postCode: string | null, instructions: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!returnAwaitingReview(order)) return { ok: false, error: 'Este pedido não tem troca ou devolução esperando análise.' };
  const r = await saveReturn(order, { return_approved_at: new Date().toISOString(), return_approved_by: by, return_post_code: postCode, return_instructions: instructions.slice(0, 1000) });
  if (r.ok) await sendReturnAnswer(order, { approved: true, postCode, instructions }).catch((e) => console.error('[devolucao] e-mail da aprovação falhou:', e));
  return r;
}

/** Etapa 1: recusa com resposta (ex.: fora das condições da política). */
export async function rejectReturn(order: Order, by: string | null, response: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!returnAwaitingReview(order)) return { ok: false, error: 'Este pedido não tem troca ou devolução esperando análise.' };
  const r = await saveReturn(order, { return_rejected_at: new Date().toISOString(), return_approved_by: by, return_response: response.slice(0, 500) });
  if (r.ok) await sendReturnAnswer(order, { approved: false, response }).catch((e) => console.error('[devolucao] e-mail da recusa falhou:', e));
  return r;
}

/**
 * Etapa 2 (Confirmação de troca ou devolução), com os itens já na loja:
 *  - reembolso: estorna o total (produtos + frete) no Mercado Pago (falhou =
 *    nada muda), põe Cancelado e aplica o estoque por item (o resto é perda);
 *  - troca: cria o pedido de reenvio (R$ 0) com os itens novos — falta de
 *    estoque = nada muda —, devolve ao estoque o que voltou em condições e o
 *    pedido original continua Entregue.
 * O cliente é avisado por e-mail nos dois casos.
 */
export async function completeReturn(
  order: Order,
  by: string | null,
  opts: { resolution: 'reembolso' | 'troca'; restock: Record<string, number>; exchange?: { product_id: string; quantity: number }[] },
): Promise<{ ok: true; refundedCents: number | null; simulated?: boolean; exchangeNumber?: string } | { ok: false; error: string }> {
  if (order.status !== 'delivered' || !returnOpen(order)) return { ok: false, error: 'Este pedido não tem troca ou devolução pendente.' };
  if (!order.return_approved_at) return { ok: false, error: 'Aprove o pedido e informe como devolver antes de concluir.' };
  const sb = supabaseAdmin();
  if (!sb) return { ok: false, error: 'Supabase não configurado.' };
  const done = { return_completed_at: new Date().toISOString(), return_completed_by: by, return_resolution: opts.resolution };

  if (opts.resolution === 'troca') {
    if (!opts.exchange?.length) return { ok: false, error: 'Escolha os itens que vão para o cliente na troca.' };
    const ex = await createExchangeOrder(order, opts.exchange);
    if ('error' in ex) return { ok: false, error: ex.error };
    // o pedido original estava Entregue (estoque já tinha saído): só o que voltou em condições entra
    const lines = stockLines(order, opts.restock);
    for (const l of lines) await adjustStock(l.product_id, l.restocked);
    await saveStock(order.id, { stock_pending: false, stock_resolution: lines, stock_resolved_at: done.return_completed_at, stock_resolved_by: by });
    await sb.from('orders').update({ ...done, exchange_order_number: ex.order.order_number }).eq('id', order.id);
    await sendOrderStatusEmail(ex.order, 'paid', { exchangeOf: order.order_number }).catch((e) => console.error('[troca] e-mail falhou:', e));
    return { ok: true, refundedCents: null, exchangeNumber: ex.order.order_number };
  }

  let refundedCents: number | null = null;
  let simulated = false;
  if (order.mp_payment_id) {
    const r = await refundPayment(order.mp_payment_id, order);
    if (!r.ok) return { ok: false, error: r.error };
    refundedCents = order.total_cents;
    simulated = !!r.simulated;
  }
  const { order: updated, error } = await changeOrderStatus(order.order_number, 'cancelled');
  if (!updated) {
    if (refundedCents) {
      await createNotification({
        kind: 'devolucao_falhou',
        message: `A devolução do pedido ${orderLabel(order.order_number)} foi estornada, mas o pedido não ficou como Cancelado (${error ?? 'erro'}). Conclua de novo no painel.`,
        order_number: order.order_number,
      });
    }
    return { ok: false, error: error || 'Não foi possível concluir a devolução.' };
  }
  // o change_order_status devolveu tudo ao estoque; o que não voltou em condições sai de novo (perda)
  await applyStockDecision(order, { mode: 'now', restock: opts.restock }, by);
  await sb.from('orders').update(done).eq('id', order.id);
  await recordCancellation(order.order_number, by, `Devolução: ${order.return_reason ?? 'sem motivo'}`);
  await sendOrderStatusEmail(updated, 'cancelled', { refundCents: refundedCents, returned: true }).catch((e) =>
    console.error('[devolucao] e-mail falhou:', e),
  );
  return { ok: true, refundedCents, simulated };
}

/** Lê "troca_product_<n>" e "troca_qty_<n>" do formulário (itens novos da troca). */
export function exchangeFromForm(form: FormData): { product_id: string; quantity: number }[] {
  const out: { product_id: string; quantity: number }[] = [];
  for (const [k, v] of form.entries()) {
    if (!k.startsWith('troca_product_')) continue;
    const quantity = Math.floor(Number(form.get(`troca_qty_${k.slice(14)}`)) || 0);
    if (String(v) && quantity > 0) out.push({ product_id: String(v), quantity: Math.min(quantity, 99) });
  }
  return out;
}

/**
 * Venda do Caixa cancelada: o que o Mercado Pago estorna sozinho (os Pix, pelos
 * ids guardados em mp_payment_id, separados por vírgula no pagamento
 * combinado) e o que a equipe devolve à mão (dinheiro no balcão, cartão na
 * maquininha — essa baixa foi manual, não passou pela API).
 */
export function caixaRefundPlan(order: Order): { pixIds: string[]; pixCents: number; manual: { label: string; cents: number }[] } {
  const pixIds = (order.mp_payment_id ?? '').split(',').map((s) => s.trim()).filter((id) => id && !id.startsWith('SIMULADO'));
  const manualLabel = (m: string) => (m === 'cash' ? 'dinheiro, no balcão' : `${PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m}, na maquininha`);
  if (order.payment_method === 'pix') return { pixIds, pixCents: pixIds.length ? order.total_cents : 0, manual: pixIds.length ? [] : [{ label: 'Pix, pelo app do banco', cents: order.total_cents }] };
  if (order.payment_method === 'misto' && order.payments?.length) {
    const sum = (m: string) => order.payments!.filter((p) => p.method === m).reduce((t, p) => t + p.amount_cents, 0);
    const pix = sum('pix');
    const credit = sum('credit_card');
    const debit = sum('debit_card');
    // dinheiro: o que sobra do total (a parte em dinheiro guarda o recebido, com troco)
    const cash = order.total_cents - pix - credit - debit;
    const manual = [
      { label: manualLabel('cash'), cents: cash },
      { label: manualLabel('credit_card'), cents: credit },
      { label: manualLabel('debit_card'), cents: debit },
      // Pix simulado (sem Mercado Pago) não tem o que estornar pela API
      ...(pixIds.length ? [] : [{ label: 'Pix, pelo app do banco', cents: pix }]),
    ].filter((m) => m.cents > 0);
    return { pixIds, pixCents: pixIds.length ? pix : 0, manual };
  }
  return { pixIds: [], pixCents: 0, manual: [{ label: manualLabel(order.payment_method ?? 'cash'), cents: order.total_cents }] };
}

/** Texto do que devolver à mão: "R$ 50,00 em dinheiro, no balcão e R$ 30,00 em Cartão de crédito, na maquininha". */
export const manualRefundText = (manual: { label: string; cents: number }[]) =>
  manual.map((m) => `${brl(m.cents)} em ${m.label}`).join(' e ');

/**
 * Estorna os Pix de uma venda do Caixa no Mercado Pago, antes de cancelar.
 * Algum falhou = não cancela (o erro diz quais já voltaram).
 * ponytail: Pix em partes estorna um a um; se um falhar no meio, os anteriores
 * já voltaram — a mensagem avisa para conferir no Mercado Pago
 */
export async function refundCaixaPix(order: Order): Promise<{ ok: true; refundedCents: number } | { ok: false; error: string }> {
  const { pixIds, pixCents } = caixaRefundPlan(order);
  let done = 0;
  for (const id of pixIds) {
    const r = await refundPayment(id, order);
    if (!r.ok) {
      return { ok: false, error: done ? `${r.error} Atenção: ${done} de ${pixIds.length} Pix já foram estornados; confira no Mercado Pago.` : r.error };
    }
    done++;
  }
  return { ok: true, refundedCents: pixCents };
}
