import type { APIRoute } from 'astro';
import { channelOf, getPaymentStatus } from '../../../lib/mercadopago';
import { getMpCredentials } from '../../../lib/repo/payment-settings';
import { logPaymentAttempt } from '../../../lib/repo/payment-attempts';
import { fulfillPaidOrder } from '../../../lib/fulfillment';
import { getOrderByNumber, setOrderStatus } from '../../../lib/repo/orders';
import { sendOrderStatusEmail } from '../../../lib/email';
import type { PaymentMethod } from '../../../lib/types';

/**
 * Webhook do Mercado Pago (notificações de pagamento).
 * Configure a URL `<site>/api/webhooks/mercadopago` no painel de Webhooks
 * do Mercado Pago e cole a "assinatura secreta" em Configurações › Meios de
 * pagamento (ou em MP_WEBHOOK_SECRET).
 *  1. recebe o id do pagamento e o tipo do evento;
 *  2. consulta o pagamento no Mercado Pago (nunca confia no corpo do aviso);
 *  3. confere metadata { order_id, channel } com a venda da referência;
 *  4. aprovado: Pago + baixa de estoque (site ou Caixa) — a tela do Pix, que
 *     consulta o status, fecha sozinha; recusado/cancelado: não concluído.
 * Cada aviso fica no histórico (payment_attempts).
 */
export const POST: APIRoute = async ({ request, url }) => {
  const rawBody = await request.text();
  let payload: { type?: string; action?: string; data?: { id?: string } } = {};
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    /* alguns testes enviam corpo vazio */
  }

  const dataId = payload.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');

  // ---- validação de assinatura (quando configurada) ----
  const secret = (await getMpCredentials())?.webhookSecret;
  if (secret) {
    const valid = await verifySignature(request, url, secret);
    if (!valid) return new Response('assinatura inválida', { status: 401 });
  }

  const topic = payload.type || url.searchParams.get('type') || url.searchParams.get('topic');
  if (topic && topic !== 'payment') {
    return new Response('ignorado', { status: 200 });
  }
  if (!dataId) return new Response('sem id', { status: 200 });

  try {
    const info = await getPaymentStatus(String(dataId));
    if (!info || !info.externalReference) {
      return new Response('pagamento não encontrado', { status: 200 });
    }
    // Pix em partes do Caixa (<pedido>:pixN): quem confirma é a tela do Caixa
    const order = await getOrderByNumber(info.externalReference);
    await logPaymentAttempt({
      orderId: order?.id ?? info.metadata?.order_id ?? null,
      orderNumber: info.externalReference,
      channel: order ? channelOf(order) : ((info.metadata?.channel as 'pos' | 'ecommerce' | undefined) ?? null),
      kind: 'webhook',
      providerPaymentId: String(dataId),
      status: info.status,
      amountCents: info.amountCents,
      payload: info.raw,
    });
    if (!order) return new Response('ok', { status: 200 });
    // metadata (cobranças novas) precisa apontar para a mesma venda
    if (info.metadata?.order_id && info.metadata.order_id !== order.id) {
      console.error('[webhook/mercadopago] metadata não confere com a venda', info.externalReference);
      return new Response('não confere', { status: 200 });
    }

    if (info.status === 'approved') {
      const method = (info.raw.payment_type_id === 'credit_card' || info.raw.payment_type_id === 'debit_card'
        ? info.raw.payment_type_id
        : 'pix') as PaymentMethod;
      await fulfillPaidOrder(info.externalReference, { paymentId: String(dataId), method });
    } else if ((info.status === 'rejected' || info.status === 'cancelled') && order.status === 'pending') {
      const failed = await setOrderStatus(info.externalReference, 'failed');
      if (failed && order.source !== 'caixa') await sendOrderStatusEmail(failed, 'failed').catch(() => {});
    }
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[webhook/mercadopago] erro:', err);
    // 200 para o MP não ficar reenviando indefinidamente por erro nosso
    return new Response('erro tratado', { status: 200 });
  }
};

async function verifySignature(request: Request, url: URL, secret: string): Promise<boolean> {
  const signature = request.headers.get('x-signature') || '';
  const requestId = request.headers.get('x-request-id') || '';
  const parts = Object.fromEntries(
    signature.split(',').map((kv) => kv.split('=').map((s) => s.trim())),
  ) as { ts?: string; v1?: string };
  if (!parts.ts || !parts.v1) return false;

  const dataId = (url.searchParams.get('data.id') || url.searchParams.get('id') || '').toLowerCase();
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === parts.v1;
}
