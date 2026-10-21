import { MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { env } from './env';
import { onlyDigits } from './format';
import { getMpCredentials, environmentOf } from './repo/payment-settings';
import { logPaymentAttempt, redactPayment } from './repo/payment-attempts';
import type { Order } from './types';

/**
 * Serviço central do Mercado Pago (a "factory"): a cada chamada lê as
 * credenciais da loja (Configurações › Meios de pagamento; sem elas, as
 * variáveis da Vercel) e monta o cliente do SDK. Sem nenhuma credencial,
 * tudo roda em modo simulado (aprovado), como antes.
 * Toda cobrança leva metadata { order_id, channel } e fica no histórico
 * (payment_attempts).
 */
async function client(): Promise<MercadoPagoConfig | null> {
  const creds = await getMpCredentials();
  return creds ? new MercadoPagoConfig({ accessToken: creds.accessToken, options: { timeout: 8000 } }) : null;
}

/** Loja com Mercado Pago de verdade (fora do modo simulado)? */
export async function mpReady(): Promise<boolean> {
  return !!(await getMpCredentials());
}

export type Channel = 'pos' | 'ecommerce';
export const channelOf = (order: Pick<Order, 'source'>): Channel => (order.source === 'caixa' ? 'pos' : 'ecommerce');

/** Erro do Mercado Pago com texto que dá para mostrar na tela. */
export class MpError extends Error {}

/** Traduz falhas do SDK/API (token inválido ou expirado, rede, recusa) para o usuário. */
export function mpErrorMessage(err: unknown): string {
  const e = err as { status?: number; message?: string; cause?: { code?: string; description?: string }[] };
  const text = `${e?.message ?? ''} ${(e?.cause ?? []).map((c) => `${c.code} ${c.description}`).join(' ')}`.toLowerCase();
  if (e?.status === 401 || e?.status === 403 || /unauthorized|invalid (access )?token|invalid_token|expired/.test(text)) {
    return 'As credenciais do Mercado Pago da loja estão inválidas ou expiraram. Peça ao Proprietário para conferir em Configurações › Meios de pagamento.';
  }
  if (/timeout|fetch failed|network|econn|enotfound/.test(text)) {
    return 'Não conseguimos falar com o Mercado Pago agora. Tente de novo em instantes.';
  }
  return 'O Mercado Pago não aceitou o pagamento. Confira os dados e tente de novo.';
}

export interface BrickFormData {
  // Vem do Payment Brick (onSubmit -> formData)
  token?: string;
  issuer_id?: string;
  payment_method_id: string;
  transaction_amount?: number;
  installments?: number;
  payer?: {
    email?: string;
    identification?: { type?: string; number?: string };
  };
}

export interface PaymentResult {
  status: 'approved' | 'pending' | 'in_process' | 'rejected' | 'simulado';
  paymentId: string | null;
  method: string;
  pix?: {
    qrCode: string;
    qrCodeBase64: string;
    ticketUrl: string;
    expiresAt: string | null;
  };
  detail?: string;
}

/**
 * Processa o pagamento no Mercado Pago. Se as credenciais não estiverem
 * configuradas, retorna um resultado `simulado` aprovado (modo demonstração).
 * Falha de comunicação/credencial vira MpError com texto para a tela.
 */
export async function processPayment(
  order: Order,
  form: BrickFormData,
  /** Pix em partes (Caixa): valor da parte e referência própria `<pedido>:pixN` */
  part?: { amountCents: number; ref: string },
): Promise<PaymentResult> {
  const cfg = await client();
  const ref = part?.ref ?? order.order_number;
  const channel = channelOf(order);
  const amountCents = part?.amountCents ?? order.total_cents;

  if (!cfg) {
    return { status: 'simulado', paymentId: `SIMULADO-${ref}`, method: form.payment_method_id || 'simulado' };
  }

  const payment = new Payment(cfg);
  const isPix = form.payment_method_id === 'pix';

  const body: Record<string, unknown> = {
    transaction_amount: amountCents / 100,
    description: `Pedido ${order.order_number} — ${env.brandName}`,
    payment_method_id: form.payment_method_id,
    external_reference: ref,
    notification_url: `${env.siteUrl}/api/webhooks/mercadopago`,
    // conferido pelo webhook junto com a referência
    metadata: { order_id: order.id, channel },
    payer: {
      email: form.payer?.email || order.customer_email,
      first_name: order.customer_name.split(/\s+/)[0],
      identification: {
        type: form.payer?.identification?.type || 'CPF',
        number: onlyDigits(form.payer?.identification?.number || order.customer_cpf),
      },
    },
  };

  if (!isPix) {
    body.token = form.token;
    body.installments = form.installments ?? 1;
    if (form.issuer_id) body.issuer_id = form.issuer_id;
  } else {
    // Pix expira em 30 minutos
    body.date_of_expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  }

  let res: Awaited<ReturnType<Payment['create']>>;
  try {
    res = await payment.create({ body: body as never, requestOptions: { idempotencyKey: ref } });
  } catch (err) {
    const message = mpErrorMessage(err);
    await logPaymentAttempt({ orderId: order.id, orderNumber: ref, channel, kind: 'charge', status: 'error', amountCents, payload: { error: message, method: form.payment_method_id } });
    throw new MpError(message);
  }

  await logPaymentAttempt({
    orderId: order.id,
    orderNumber: ref,
    channel,
    kind: 'charge',
    providerPaymentId: res.id ? String(res.id) : null,
    status: res.status ?? 'unknown',
    amountCents,
    payload: redactPayment(res),
  });

  const result: PaymentResult = {
    status: (res.status as PaymentResult['status']) ?? 'pending',
    paymentId: res.id ? String(res.id) : null,
    method: form.payment_method_id,
    detail: res.status_detail,
  };

  const tx = res.point_of_interaction?.transaction_data;
  if (isPix && tx) {
    result.pix = {
      qrCode: tx.qr_code ?? '',
      qrCodeBase64: tx.qr_code_base64 ?? '',
      ticketUrl: tx.ticket_url ?? '',
      expiresAt: (res.date_of_expiration as string | undefined) ?? null,
    };
  }

  return result;
}

export async function getPaymentStatus(paymentId: string): Promise<{
  status: string;
  externalReference: string | null;
  metadata: { order_id?: string; channel?: string } | null;
  amountCents: number | null;
  raw: Record<string, unknown>;
} | null> {
  const cfg = await client();
  if (!cfg) return null;
  try {
    const res = await new Payment(cfg).get({ id: paymentId });
    return {
      status: res.status ?? 'unknown',
      externalReference: (res.external_reference as string | undefined) ?? null,
      metadata: (res.metadata as { order_id?: string; channel?: string } | undefined) ?? null,
      amountCents: res.transaction_amount != null ? Math.round(res.transaction_amount * 100) : null,
      raw: redactPayment(res),
    };
  } catch (err) {
    console.error('[mercadopago] getPaymentStatus falhou:', err);
    return null;
  }
}

/**
 * Estorno total de um pagamento (cancelamento de compra online). Pagamento
 * simulado (sem Mercado Pago configurado) não tem o que estornar.
 */
export async function refundPayment(paymentId: string): Promise<{ ok: true; simulated?: boolean } | { ok: false; error: string }> {
  const cfg = await client();
  if (!cfg || paymentId.startsWith('SIMULADO')) return { ok: true, simulated: true };
  try {
    const res = await new PaymentRefund(cfg).create({ payment_id: paymentId, requestOptions: { idempotencyKey: `refund-${paymentId}` } });
    await logPaymentAttempt({ kind: 'refund', providerPaymentId: paymentId, status: res.status ?? 'approved', amountCents: res.amount != null ? Math.round(res.amount * 100) : null });
    return { ok: true };
  } catch (err) {
    const msg = mpErrorMessage(err);
    await logPaymentAttempt({ kind: 'refund', providerPaymentId: paymentId, status: 'error', payload: { error: msg } });
    return { ok: false, error: `O estorno não foi feito: ${msg} Nada foi cancelado.` };
  }
}

/**
 * Testa um par de credenciais antes de salvar: o token precisa ser aceito pelo
 * Mercado Pago (conta do Brasil), a Public Key também, e os dois do mesmo
 * ambiente (TEST-… ou APP_USR-…).
 */
export async function verifyMpCredentials(accessToken: string, publicKey: string): Promise<
  { ok: true; environment: 'test' | 'production'; account: string } | { ok: false; error: string }
> {
  const envToken = environmentOf(accessToken);
  const envKey = environmentOf(publicKey);
  if (!envToken) return { ok: false, error: 'Access Token inválido: ele começa com APP_USR- (produção) ou TEST- (teste).' };
  if (!envKey) return { ok: false, error: 'Public Key inválida: ela começa com APP_USR- (produção) ou TEST- (teste).' };
  if (envToken !== envKey) return { ok: false, error: 'O Access Token e a Public Key são de ambientes diferentes (um de teste e outro de produção).' };
  try {
    const me = await fetch('https://api.mercadopago.com/users/me', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
    if (me.status === 401 || me.status === 403) return { ok: false, error: 'O Mercado Pago recusou o Access Token (inválido ou expirado).' };
    if (!me.ok) return { ok: false, error: `O Mercado Pago não respondeu como esperado (${me.status}). Tente de novo.` };
    const user = (await me.json()) as { nickname?: string; email?: string; site_id?: string };
    if (user.site_id && user.site_id !== 'MLB') return { ok: false, error: `Essa conta é do Mercado Pago de outro país (${user.site_id}); a loja cobra em reais (Brasil).` };
    const pk = await fetch(`https://api.mercadopago.com/v1/payment_methods/search?public_key=${encodeURIComponent(publicKey)}&marketplace=NONE`, { signal: AbortSignal.timeout(8000) });
    if (!pk.ok) return { ok: false, error: 'O Mercado Pago recusou a Public Key.' };
    return { ok: true, environment: envToken, account: user.nickname || user.email || 'conta Mercado Pago' };
  } catch {
    return { ok: false, error: 'Não conseguimos falar com o Mercado Pago agora. Tente de novo em instantes.' };
  }
}
