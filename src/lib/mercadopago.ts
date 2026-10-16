import { MercadoPagoConfig, Payment, PaymentRefund } from 'mercadopago';
import { env, hasMercadoPago } from './env';
import { onlyDigits } from './format';
import type { Order } from './types';

export { hasMercadoPago };

function client(): MercadoPagoConfig | null {
  if (!hasMercadoPago) return null;
  return new MercadoPagoConfig({
    accessToken: env.mpAccessToken,
    options: { timeout: 8000 },
  });
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
 */
export async function processPayment(
  order: Order,
  form: BrickFormData,
  /** Pix em partes (Caixa): valor da parte e referência própria `<pedido>:pixN` */
  part?: { amountCents: number; ref: string },
): Promise<PaymentResult> {
  const cfg = client();
  const ref = part?.ref ?? order.order_number;

  if (!cfg) {
    return { status: 'simulado', paymentId: `SIMULADO-${ref}`, method: form.payment_method_id || 'simulado' };
  }

  const payment = new Payment(cfg);
  const isPix = form.payment_method_id === 'pix';

  const body: Record<string, unknown> = {
    transaction_amount: (part?.amountCents ?? order.total_cents) / 100,
    description: `Pedido ${order.order_number} — ${env.brandName}`,
    payment_method_id: form.payment_method_id,
    external_reference: ref,
    notification_url: `${env.siteUrl}/api/webhooks/mercadopago`,
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

  const res = await payment.create({
    body: body as never,
    requestOptions: { idempotencyKey: ref },
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

export async function getPaymentStatus(
  paymentId: string,
): Promise<{ status: string; externalReference: string | null } | null> {
  const cfg = client();
  if (!cfg) return null;
  try {
    const payment = new Payment(cfg);
    const res = await payment.get({ id: paymentId });
    return {
      status: res.status ?? 'unknown',
      externalReference: (res.external_reference as string | undefined) ?? null,
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
  const cfg = client();
  if (!cfg || paymentId.startsWith('SIMULADO')) return { ok: true, simulated: true };
  try {
    await new PaymentRefund(cfg).create({ payment_id: paymentId, requestOptions: { idempotencyKey: `refund-${paymentId}` } });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
    return { ok: false, error: `O Mercado Pago recusou o estorno (${msg}). Nada foi cancelado.` };
  }
}
