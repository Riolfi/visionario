import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';

/**
 * Histórico das tentativas de pagamento (migration 0027) para conciliação:
 * cada cobrança criada, cada aviso do webhook e cada estorno. A resposta do
 * Mercado Pago é gravada SEM dados pessoais do pagador (LGPD): só os campos
 * de PICK — status, motivo, forma, parcelas, valores e datas.
 */
const PICK = [
  'id', 'status', 'status_detail', 'payment_method_id', 'payment_type_id', 'installments',
  'transaction_amount', 'currency_id', 'date_created', 'date_approved', 'date_last_updated',
  'date_of_expiration', 'external_reference', 'metadata', 'live_mode',
] as const;

export function redactPayment(res: unknown): Record<string, unknown> {
  const src = (res ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PICK) if (src[k] !== undefined) out[k] = src[k];
  const td = src.transaction_details as Record<string, unknown> | undefined;
  if (td) out.transaction_details = { net_received_amount: td.net_received_amount, total_paid_amount: td.total_paid_amount };
  return out;
}

export async function logPaymentAttempt(a: {
  orderId?: string | null;
  orderNumber?: string | null;
  channel?: 'pos' | 'ecommerce' | null;
  kind: 'charge' | 'webhook' | 'refund';
  providerPaymentId?: string | null;
  status: string;
  amountCents?: number | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const sb = supabaseAdmin();
  if (!hasSupabase || !sb) return;
  // sem a migration 0027 só não grava: nunca derruba o pagamento
  await sb
    .from('payment_attempts')
    .insert({
      order_id: a.orderId ?? null,
      order_number: a.orderNumber ?? null,
      channel: a.channel ?? null,
      kind: a.kind,
      provider_payment_id: a.providerPaymentId ?? null,
      status: a.status,
      amount_cents: a.amountCents ?? null,
      response_payload: a.payload ?? null,
    })
    .then(({ error }) => error && console.warn('[payment_attempts] não gravou:', error.message), () => {});
}
