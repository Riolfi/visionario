import type { Order, OrderItem, OrderStatus, PaymentMethod, PaymentPart, ShippingAddress } from '../types';
import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { readCatalog, writeCatalog, readOrders, writeOrders } from '../localstore';
import { getProductById } from './catalog';
import { generateOrderNumber } from '../format';

export interface CreateOrderInput {
  customer: { name: string; email: string; phone: string; cpf: string };
  shipping: ShippingAddress;
  shipping_cents: number;
  items: { product_id: string; quantity: number }[];
  userId?: string | null;
}

export interface PricedOrderDraft {
  order: Order;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToOrder(row: any, items: any[]): Order {
  return {
    id: row.id,
    order_number: row.order_number,
    status: row.status,
    user_id: row.user_id ?? null,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    customer_phone: row.customer_phone,
    customer_cpf: row.customer_cpf,
    shipping_cep: row.shipping_cep,
    shipping_address: row.shipping_address,
    shipping_cents: row.shipping_cents,
    subtotal_cents: row.subtotal_cents,
    total_cents: row.total_cents,
    payment_method: row.payment_method,
    payments: row.payments ?? null,
    mp_payment_id: row.mp_payment_id,
    tracking_code: row.tracking_code ?? null,
    source: row.source === 'caixa' ? 'caixa' : 'web',
    items: (items ?? []).map((i) => ({
      id: i.id,
      product_id: i.product_id,
      product_name: i.product_name,
      product_slug: i.product_slug ?? undefined,
      unit_price_cents: i.unit_price_cents,
      quantity: i.quantity,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Resolve preços, nomes e estoque NO SERVIDOR a partir do catálogo —
 * nunca confiamos nos valores enviados pelo cliente.
 */
export async function priceCart(
  lines: { product_id: string; quantity: number }[],
): Promise<{ items: OrderItem[]; subtotalCents: number }> {
  if (!lines.length) throw new Error('Carrinho vazio.');
  const items: OrderItem[] = [];
  let subtotal = 0;
  for (const line of lines) {
    const product = await getProductById(line.product_id);
    if (!product || !product.is_active) throw new Error('Produto indisponível no carrinho.');
    const qty = Math.max(1, Math.floor(line.quantity));
    if (product.stock < qty) throw new Error(`Estoque insuficiente para "${product.name}".`);
    subtotal += product.price_cents * qty;
    items.push({
      product_id: product.id,
      product_name: product.name,
      product_slug: product.slug,
      unit_price_cents: product.price_cents,
      quantity: qty,
    });
  }
  return { items, subtotalCents: subtotal };
}

/**
 * Cria um pedido com status `pending`.
 */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const { items, subtotalCents: subtotal } = await priceCart(input.items);

  const shipping = Math.max(0, Math.floor(input.shipping_cents || 0));
  const total = subtotal + shipping;
  const orderNumber = await newOrderNumber();
  const now = new Date().toISOString();

  const base: Order = {
    id: crypto.randomUUID(),
    order_number: orderNumber,
    status: 'pending',
    user_id: input.userId ?? null,
    customer_name: input.customer.name,
    customer_email: input.customer.email,
    customer_phone: input.customer.phone,
    customer_cpf: input.customer.cpf,
    shipping_cep: input.shipping.cep,
    shipping_address: input.shipping,
    shipping_cents: shipping,
    subtotal_cents: subtotal,
    total_cents: total,
    payment_method: null,
    mp_payment_id: null,
    tracking_code: null,
    source: 'web',
    items,
    created_at: now,
    updated_at: now,
  };

  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data: orderRow, error } = await sb
      .from('orders')
      .insert({
        order_number: base.order_number,
        status: base.status,
        user_id: base.user_id,
        customer_name: base.customer_name,
        customer_email: base.customer_email,
        customer_phone: base.customer_phone,
        customer_cpf: base.customer_cpf,
        shipping_cep: base.shipping_cep,
        shipping_address: base.shipping_address,
        shipping_cents: base.shipping_cents,
        subtotal_cents: base.subtotal_cents,
        total_cents: base.total_cents,
      })
      .select()
      .single();
    if (error) throw error;

    const itemsPayload = items.map((i) => ({
      order_id: orderRow.id,
      product_id: i.product_id,
      product_name: i.product_name,
      product_slug: i.product_slug ?? null,
      unit_price_cents: i.unit_price_cents,
      quantity: i.quantity,
    }));
    const { error: itemsError } = await sb.from('order_items').insert(itemsPayload);
    if (itemsError) throw itemsError;

    return rowToOrder(orderRow, itemsPayload);
  }

  const orders = await readOrders();
  orders.unshift(base);
  await writeOrders(orders);
  return base;
}

// ---------------------------------------------------------------------------
// Caixa (PDV interno) — venda de balcão. Só com Supabase.
// ---------------------------------------------------------------------------

export interface CaixaSaleInput {
  items: { product_id: string; quantity: number }[];
  method: PaymentMethod;
  /** pagamento combinado (method = 'misto') */
  payments?: PaymentPart[];
}

/**
 * Registra uma venda de balcão: cria o pedido já `paid` com `source='caixa'`
 * e baixa o estoque numa única transação no banco (RPC `caixa_checkout`).
 * Preço e nome saem do catálogo — nunca do cliente.
 */
export async function createCaixaSale(input: CaixaSaleInput): Promise<Order> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) throw new Error('O Caixa exige o Supabase configurado.');

  const lines = (input.items ?? [])
    .map((i) => ({ product_id: String(i.product_id), quantity: Math.max(1, Math.floor(i.quantity)) }))
    .filter((i) => i.product_id && i.quantity > 0);
  if (!lines.length) throw new Error('Venda sem itens.');

  const orderNumber = await newOrderNumber();
  const { error } = await sb.rpc('caixa_checkout', {
    p_order_number: orderNumber,
    p_method: input.method,
    p_items: lines,
  });
  if (error) throw new Error(error.message || 'Falha ao registrar a venda.');
  // ponytail: grava as formas fora da RPC; se falhar, a venda fica 'misto' sem o detalhe
  if (input.payments?.length) {
    await sb.from('orders').update({ payments: input.payments }).eq('order_number', orderNumber);
  }

  const order = await getOrderByNumber(orderNumber);
  if (!order) throw new Error('Venda registrada, mas não foi possível recarregá-la. Confira em Pedidos.');
  return order;
}

/**
 * Cria um pedido de balcão `pending` (source='caixa', payment_method='pix')
 * pra gerar uma cobrança Pix de verdade. Preço e nome saem do catálogo — o
 * mesmo `priceCart` do checkout online, que já valida ativo/estoque.
 *
 * Diferente de `createCaixaSale`, aqui NÃO baixa estoque na criação: o
 * pedido só vira `paid` (e o estoque só desce) quando o pagamento for
 * confirmado, via o mesmo pipeline `confirmOrderPayment`/`fulfillPaidOrder`
 * usado pelo checkout do site e pelo webhook do Mercado Pago.
 */
export async function createCaixaPixOrder(input: {
  items: { product_id: string; quantity: number }[];
  /** pagamento combinado: o Pix é só uma das partes */
  payments?: PaymentPart[];
}): Promise<Order> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) throw new Error('O Caixa exige o Supabase configurado.');

  const { items, subtotalCents } = await priceCart(input.items);
  const orderNumber = await newOrderNumber();

  const { data: orderRow, error } = await sb
    .from('orders')
    .insert({
      order_number: orderNumber,
      status: 'pending',
      source: 'caixa',
      customer_name: 'Consumidor',
      customer_email: '',
      subtotal_cents: subtotalCents,
      total_cents: subtotalCents,
      payment_method: input.payments ? 'misto' : 'pix',
      // só manda a coluna quando usa (Pix normal segue funcionando sem a migration 0017)
      ...(input.payments ? { payments: input.payments } : {}),
    })
    .select()
    .single();
  if (error) throw error;

  const itemsPayload = items.map((i) => ({
    order_id: orderRow.id,
    product_id: i.product_id,
    product_name: i.product_name,
    product_slug: i.product_slug ?? null,
    unit_price_cents: i.unit_price_cents,
    quantity: i.quantity,
  }));
  const { error: itemsError } = await sb.from('order_items').insert(itemsPayload);
  if (itemsError) throw itemsError;

  return rowToOrder(orderRow, itemsPayload);
}

export type CancelCaixaOutcome = 'cancelled' | 'already_cancelled' | 'not_found' | 'not_caixa';

/** Cancela uma venda de caixa e devolve o estoque (RPC `cancel_caixa_sale`). */
export async function cancelCaixaSale(orderNumber: string): Promise<CancelCaixaOutcome> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) throw new Error('O Caixa exige o Supabase configurado.');
  const { data, error } = await sb.rpc('cancel_caixa_sale', { p_order_number: orderNumber });
  if (error) throw new Error(error.message || 'Falha ao cancelar a venda.');
  return (data as CancelCaixaOutcome) ?? 'not_found';
}

/** Número de pedido ainda não usado (5 dígitos; se a faixa estiver muito
 *  cheia, passa pra 6). A coluna é unique no banco — isto só evita colisão
 *  na prática, a constraint continua sendo a garantia final. */
async function newOrderNumber(): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const n = generateOrderNumber(i < 8 ? 5 : 6);
    if (!(await getOrderByNumber(n))) return n;
  }
  return generateOrderNumber(7);
}

/** Busca pelo id interno (uuid). É a chave das páginas/rotas PÚBLICAS do
 *  pedido (confirmação, status do pagamento): o número exibido (#13453) é
 *  curto e adivinhável, o uuid não. */
export async function getOrderById(id: string): Promise<Order | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data: row, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const { data: items } = await sb.from('order_items').select('*').eq('order_id', row.id);
    return rowToOrder(row, items ?? []);
  }
  const orders = await readOrders();
  return orders.find((o) => o.id === id) ?? null;
}

export async function getOrderByNumber(orderNumber: string): Promise<Order | null> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data: row, error } = await sb
      .from('orders')
      .select('*')
      .eq('order_number', orderNumber)
      .maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const { data: items } = await sb.from('order_items').select('*').eq('order_id', row.id);
    return rowToOrder(row, items ?? []);
  }
  const orders = await readOrders();
  return orders.find((o) => o.order_number === orderNumber) ?? null;
}

export async function listOrders(limit = 100): Promise<Order[]> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data: rows, error } = await sb
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const ids = (rows ?? []).map((r) => r.id);
    const { data: allItems } = ids.length
      ? await sb.from('order_items').select('*').in('order_id', ids)
      : { data: [] as any[] };
    return (rows ?? []).map((r) =>
      rowToOrder(r, (allItems ?? []).filter((i: any) => i.order_id === r.id)),
    );
  }
  const orders = await readOrders();
  return orders.slice(0, limit);
}

/**
 * Confirma o pagamento: marca o pedido como `paid` e DECREMENTA o estoque de
 * forma atômica. Idempotente — chamar duas vezes não decrementa duas vezes.
 */
export interface ConfirmResult {
  order: Order | null;
  outcome: 'confirmed' | 'already_paid' | 'not_found';
}

export async function confirmOrderPayment(
  orderNumber: string,
  opts: { paymentId: string | null; method: PaymentMethod },
): Promise<ConfirmResult> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.rpc('confirm_order_payment', {
      p_order_number: orderNumber,
      p_payment_id: opts.paymentId,
      p_method: opts.method,
    });
    if (error) throw error;
    const outcome = (data as ConfirmResult['outcome']) ?? 'not_found';
    const order = outcome === 'not_found' ? null : await getOrderByNumber(orderNumber);
    return { order, outcome };
  }

  // Fallback local
  const orders = await readOrders();
  const order = orders.find((o) => o.order_number === orderNumber);
  if (!order) return { order: null, outcome: 'not_found' };
  if (order.status === 'paid') return { order, outcome: 'already_paid' };

  const catalog = await readCatalog();
  for (const item of order.items) {
    const product = catalog.products.find((p) => p.id === item.product_id);
    if (product) product.stock = Math.max(0, product.stock - item.quantity);
  }
  await writeCatalog(catalog);

  order.status = 'paid';
  order.payment_method = opts.method;
  order.mp_payment_id = opts.paymentId;
  order.updated_at = new Date().toISOString();
  await writeOrders(orders);
  return { order, outcome: 'confirmed' };
}

// ---------------------------------------------------------------------------
// Pedidos vinculados a uma conta de cliente (requer Supabase)
// ---------------------------------------------------------------------------

export async function listOrdersByUser(userId: string, limit = 50): Promise<Order[]> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return [];
  const { data: rows, error } = await sb
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const ids = (rows ?? []).map((r) => r.id);
  const { data: allItems } = ids.length
    ? await sb.from('order_items').select('*').in('order_id', ids)
    : { data: [] as any[] };
  return (rows ?? []).map((r) =>
    rowToOrder(r, (allItems ?? []).filter((i: any) => i.order_id === r.id)),
  );
}

export async function getUserOrder(userId: string, orderNumber: string): Promise<Order | null> {
  const order = await getOrderByNumber(orderNumber);
  if (!order || order.user_id !== userId) return null;
  return order;
}

/** Vincula pedidos feitos como convidado (mesmo e-mail, sem dono) à conta. */
export async function claimGuestOrders(email: string, userId: string): Promise<number> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb || !email) return 0;
  const { data, error } = await sb
    .from('orders')
    .update({ user_id: userId })
    .is('user_id', null)
    .ilike('customer_email', email)
    .select('id');
  if (error) {
    console.error('[orders] claimGuestOrders falhou:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

export async function setOrderStatus(
  orderNumber: string,
  status: OrderStatus,
  opts: { trackingCode?: string | null } = {},
): Promise<Order | null> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (opts.trackingCode !== undefined) patch.tracking_code = opts.trackingCode || null;

  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('orders').update(patch).eq('order_number', orderNumber);
    if (error) {
      console.error(`[orders] setOrderStatus(${orderNumber} -> ${status}) falhou:`, error.message);
      return null;
    }
    return getOrderByNumber(orderNumber);
  }

  const orders = await readOrders();
  const order = orders.find((o) => o.order_number === orderNumber);
  if (!order) return null;
  order.status = status;
  if (opts.trackingCode !== undefined) order.tracking_code = opts.trackingCode || null;
  order.updated_at = new Date().toISOString();
  await writeOrders(orders);
  return order;
}

/**
 * Mudança de status pelo painel (Pedidos): acompanha o estoque numa transação
 * no banco (RPC `change_order_status`, migration 0014) — cancelar pedido pago
 * devolve os itens; marcar como pago baixa. Sem a migration, cai no update
 * simples de antes.
 */
export async function changeOrderStatus(
  orderNumber: string,
  status: OrderStatus,
  opts: { trackingCode?: string | null } = {},
): Promise<{ order: Order | null; error?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.rpc('change_order_status', {
      p_order_number: orderNumber,
      p_status: status,
      p_tracking: opts.trackingCode === undefined ? null : (opts.trackingCode ?? ''),
    });
    if (!error) return { order: data === 'not_found' ? null : await getOrderByNumber(orderNumber) };
    // função ainda não existe (migration 0014 não rodou): comportamento antigo
    if (error.code !== 'PGRST202' && !/change_order_status/.test(error.message)) {
      return { order: null, error: error.message };
    }
  }
  return { order: await setOrderStatus(orderNumber, status, opts) };
}
