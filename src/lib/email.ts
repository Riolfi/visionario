import { Resend } from 'resend';
import { env, hasResend } from './env';
import { writeEmailFile } from './localstore';
import { brl, orderLabel } from './format';
import type { Order, OrderStatus } from './types';

type MailResult = { delivered: 'resend' | 'file' | 'none'; ref?: string | null };

// ---------------------------------------------------------------------------
// Conteúdo por status
// ---------------------------------------------------------------------------

interface StatusCopy {
  subject: string;
  headline: string;
  body: string;
}

/** extra.refundCents: valor estornado no cancelamento (null = nada foi cobrado) */
export interface StatusExtra {
  refundCents?: number | null;
  /** cancelado por devolução concluída (o cliente devolveu o produto) */
  returned?: boolean;
}

function statusCopy(order: Order, status: OrderStatus, extra: StatusExtra = {}): StatusCopy {
  const n = orderLabel(order.order_number);
  const first = firstName(order.customer_name);
  switch (status) {
    case 'pending':
      return {
        subject: `Recebemos o seu pedido ${n} — ${env.brandName}`,
        headline: 'Recebemos o seu pedido',
        body: `Olá, ${first}. Seu pedido <strong>${n}</strong> foi registrado e está aguardando a confirmação do pagamento. Assim que ele for aprovado, avisamos por aqui.`,
      };
    case 'paid':
      return {
        subject: `Pagamento confirmado — pedido ${n} — ${env.brandName}`,
        headline: 'Pagamento confirmado',
        body: `Olá, ${first}. O pagamento do pedido <strong>${n}</strong> foi confirmado. Avisamos quando ele entrar em separação e quando for postado.`,
      };
    case 'separating':
      return {
        subject: `Seu pedido ${n} está em separação — ${env.brandName}`,
        headline: 'Pedido em separação',
        body: `Olá, ${first}. Já estamos separando os produtos do pedido <strong>${n}</strong>. Você recebe o código de rastreio assim que ele for postado.`,
      };
    case 'shipped':
      return {
        subject: `Seu pedido ${n} está a caminho — ${env.brandName}`,
        headline: 'Seu pedido está a caminho',
        body: `Olá, ${first}. O pedido <strong>${n}</strong> foi postado e está a caminho do seu endereço.${
          !order.tracking_code
            ? ''
            : /^https?:\/\//i.test(order.tracking_code)
              ? ` Acompanhe a entrega: <a href="${escapeHtml(order.tracking_code)}">rastrear o pedido</a>.`
              : ` Acompanhe pelo código de rastreio <strong>${escapeHtml(order.tracking_code)}</strong>: <a href="https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(order.tracking_code)}">rastrear nos Correios</a>.`
        }`,
      };
    case 'delivered':
      return {
        subject: `Seu pedido ${n} foi entregue — ${env.brandName}`,
        headline: 'Seu pedido foi entregue',
        body: `Olá, ${first}. Segundo a transportadora, o pedido <strong>${n}</strong> foi entregue. Esperamos que você aproveite — qualquer coisa, é só responder este e-mail.`,
      };
    case 'failed':
      return {
        subject: `Não conseguimos confirmar o pagamento do pedido ${n} — ${env.brandName}`,
        headline: 'Problema com o pagamento',
        body: `Olá, ${first}. Não conseguimos confirmar o pagamento do pedido <strong>${n}</strong>. Nenhum valor foi cobrado. Você pode tentar novamente a qualquer momento.`,
      };
    case 'cancelled':
      if (extra.returned) {
        return {
          subject: `Devolução concluída — pedido ${n} — ${env.brandName}`,
          headline: 'Devolução concluída',
          body: `Olá, ${first}. Recebemos o produto devolvido do pedido <strong>${n}</strong>.${
            extra.refundCents
              ? ` O valor de <strong>${brl(extra.refundCents)}</strong> foi estornado para o mesmo meio de pagamento: no Pix volta em instantes; no cartão, aparece como crédito em até 2 faturas, conforme o banco.`
              : ' Se algum valor foi cobrado, o estorno é feito pelo mesmo meio de pagamento.'
          }`,
        };
      }
      return {
        subject: `Pedido ${n} cancelado — ${env.brandName}`,
        headline: 'Pedido cancelado',
        body: `Olá, ${first}. O pedido <strong>${n}</strong> foi cancelado.${
          extra.refundCents
            ? ` O valor de <strong>${brl(extra.refundCents)}</strong> foi estornado para o mesmo meio de pagamento: no Pix volta em instantes; no cartão, aparece como crédito em até 2 faturas, conforme o banco.`
            : extra.refundCents === null
              ? ' Nenhum valor foi cobrado.'
              : ' Se algum valor foi cobrado, o estorno é feito automaticamente pelo meio de pagamento.'
        }`,
      };
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function orderStatusHtml(order: Order, status: OrderStatus, extra: StatusExtra = {}): string {
  const copy = statusCopy(order, status, extra);
  const addr = order.shipping_address;

  const rows = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #EEE9E0;color:#211E1B;font-size:14px">
          ${escapeHtml(i.product_name)}<br>
          <span style="color:#8A837A;font-size:12px">Qtd. ${i.quantity} &times; ${brl(i.unit_price_cents)}</span>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #EEE9E0;text-align:right;color:#211E1B;font-size:14px;white-space:nowrap">
          ${brl(i.unit_price_cents * i.quantity)}
        </td>
      </tr>`,
    )
    .join('');

  const trackingBlock =
    status === 'shipped' && order.tracking_code
      ? `<div style="background:#E3ECE9;border-radius:2px;padding:14px 18px;margin:0 0 24px;font-size:14px;color:#211E1B">
           <strong>Código de rastreio:</strong> ${escapeHtml(order.tracking_code)}
         </div>`
      : '';

  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#F6F3EE;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="letter-spacing:0.22em;text-transform:uppercase;font-size:12px;color:#6F9C94">${escapeHtml(env.brandName)}</div>
    <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;color:#211E1B;margin:16px 0 8px">
      ${copy.headline}
    </h1>
    <p style="color:#4A4540;font-size:15px;line-height:1.6;margin:0 0 24px">${copy.body}</p>

    ${trackingBlock}

    <table style="width:100%;border-collapse:collapse;margin:0 0 8px">${rows}</table>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px;color:#4A4540">
      <tr><td style="padding:4px 0">Subtotal</td><td style="padding:4px 0;text-align:right">${brl(order.subtotal_cents)}</td></tr>
      <tr><td style="padding:4px 0">Frete</td><td style="padding:4px 0;text-align:right">${order.shipping_cents === 0 ? 'Grátis' : brl(order.shipping_cents)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:700;color:#211E1B;border-top:1px solid #EEE9E0">Total</td>
          <td style="padding:8px 0;text-align:right;font-weight:700;color:#211E1B;border-top:1px solid #EEE9E0">${brl(order.total_cents)}</td></tr>
    </table>

    <div style="background:#fff;border:1px solid #EEE9E0;border-radius:2px;padding:16px 18px;margin:0 0 24px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.14em;color:#8A837A;margin-bottom:6px">Entrega</div>
      <div style="font-size:14px;color:#211E1B;line-height:1.6">
        ${escapeHtml(addr.street)}, ${escapeHtml(addr.number)}${addr.complement ? ' — ' + escapeHtml(addr.complement) : ''}<br>
        ${escapeHtml(addr.district)} — ${escapeHtml(addr.city)}/${escapeHtml(addr.state)}<br>
        CEP ${escapeHtml(addr.cep)}
      </div>
    </div>

    <p style="color:#8A837A;font-size:13px;line-height:1.6;margin:0">
      Dúvidas? Responda este e-mail ou fale com a gente no WhatsApp.<br>
      ${escapeHtml(env.brandName)}
    </p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function deliver(to: string, subject: string, html: string, fileName: string): Promise<MailResult> {
  if (hasResend) {
    try {
      const resend = new Resend(env.resendApiKey);
      const { data, error } = await resend.emails.send({ from: env.resendFrom, to, subject, html });
      if (!error) return { delivered: 'resend', ref: data?.id };
      console.error('[email] Resend error:', error);
    } catch (err) {
      console.error('[email] Resend threw:', err);
    }
  }
  const file = await writeEmailFile(fileName, html);
  if (file) {
    console.info(`[email] (fallback) "${subject}" gravado em ${file}`);
    return { delivered: 'file', ref: file };
  }
  return { delivered: 'none', ref: null };
}

/** Dispara o e-mail correspondente a um status do pedido. */
export async function sendOrderStatusEmail(order: Order, status: OrderStatus, extra: StatusExtra = {}): Promise<MailResult> {
  const copy = statusCopy(order, status, extra);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return deliver(
    order.customer_email,
    copy.subject,
    orderStatusHtml(order, status, extra),
    `${order.order_number}-${status}-${stamp}`,
  );
}

/** Compat: e-mail de confirmação de pagamento. */
export function sendOrderConfirmation(order: Order): Promise<MailResult> {
  return sendOrderStatusEmail(order, 'paid');
}

export async function sendContactMessage(msg: {
  name: string;
  email: string;
  phone?: string;
  message: string;
  /** e-mail de atendimento (Conteúdo › Atendimento); sem ele, o do remetente */
  to?: string;
}): Promise<{ delivered: 'resend' | 'file' | 'none' }> {
  const html = `<h2>Mensagem pelo site</h2>
    <p><strong>Nome:</strong> ${escapeHtml(msg.name)}</p>
    <p><strong>E-mail:</strong> ${escapeHtml(msg.email)}</p>
    ${msg.phone ? `<p><strong>Telefone:</strong> ${escapeHtml(msg.phone)}</p>` : ''}
    <p><strong>Mensagem:</strong></p>
    <p>${escapeHtml(msg.message).replace(/\n/g, '<br>')}</p>`;

  const to = msg.to?.trim() || env.resendFrom.match(/<(.+)>/)?.[1] || 'ola@lojavisionario.com.br';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (hasResend) {
    try {
      const resend = new Resend(env.resendApiKey);
      const { error } = await resend.emails.send({
        from: env.resendFrom,
        to,
        replyTo: msg.email,
        subject: `Contato pelo site — ${msg.name}`,
        html,
      });
      if (!error) return { delivered: 'resend' };
    } catch (err) {
      console.error('[email] contato Resend falhou:', err);
    }
  }
  const file = await writeEmailFile(`contato-${stamp}`, html);
  return { delivered: file ? 'file' : 'none' };
}

function firstName(name: string): string {
  return (name || '').trim().split(/\s+/)[0] || 'tudo bem';
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Boas-vindas à equipe (ou senha redefinida) com a senha temporária definida
 * pelo administrador. No primeiro login a pessoa é obrigada a trocá-la.
 */
export async function sendTeamPasswordEmail(opts: {
  to: string;
  name: string;
  password: string;
  kind: 'welcome' | 'reset';
  /** link "Criar senha" (e-mail preenchido; pede a temporária e a nova) */
  setupUrl?: string;
}): Promise<MailResult> {
  const welcome = opts.kind === 'welcome';
  const html = `<p>Olá, ${escapeHtml(firstName(opts.name))}.</p>
    <p>${welcome ? `Você foi adicionado(a) à equipe da ${escapeHtml(env.brandName)}.` : 'A sua senha de acesso foi redefinida por um administrador.'}</p>
    <p>E-mail: <strong>${escapeHtml(opts.to)}</strong><br>Senha temporária: <strong>${escapeHtml(opts.password)}</strong></p>
    <p>Ao entrar, você vai criar uma senha nova. A temporária deixa de valer e ninguém da equipe vê a nova.</p>${
      opts.setupUrl ? `<p><a href="${opts.setupUrl}">Criar minha senha</a> (o link vale 7 dias)</p>` : ''
    }`;
  if (!hasResend) return { delivered: (await writeEmailFile(`equipe-${Date.now()}`, html)) ? 'file' : 'none' };
  try {
    const { data, error } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: opts.to,
      subject: welcome ? `Boas-vindas à equipe — ${env.brandName}` : `Sua senha foi redefinida — ${env.brandName}`,
      html,
    });
    if (!error) return { delivered: 'resend', ref: data?.id ?? null };
    console.error('[email] equipe Resend falhou:', error.message);
  } catch (err) {
    console.error('[email] equipe Resend falhou:', err);
  }
  return { delivered: 'none' };
}

/** Convite à equipe sem senha (conta criada por quem não é Administrador): a pessoa cria a senha pelo "Esqueci minha senha". */
export async function sendTeamInviteEmail(opts: { to: string; name: string }): Promise<MailResult> {
  const url = `${env.siteUrl}/esqueci-senha?criar=1&email=${encodeURIComponent(opts.to)}`;
  const html = `<p>Olá, ${escapeHtml(firstName(opts.name))}.</p>
    <p>Criamos a sua conta na equipe da ${escapeHtml(env.brandName)} com o e-mail <strong>${escapeHtml(opts.to)}</strong>.</p>
    <p>Para entrar, crie a sua senha: <a href="${url}">criar minha senha</a>. Um Administrador vai definir o seu cargo.</p>`;
  if (!hasResend) return { delivered: (await writeEmailFile(`convite-${Date.now()}`, html)) ? 'file' : 'none' };
  try {
    const { data, error } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: opts.to,
      subject: `Sua conta na equipe — ${env.brandName}`,
      html,
    });
    if (!error) return { delivered: 'resend', ref: data?.id ?? null };
    console.error('[email] convite Resend falhou:', error.message);
  } catch (err) {
    console.error('[email] convite Resend falhou:', err);
  }
  return { delivered: 'none' };
}

/**
 * Tentaram criar conta com um e-mail que já tem conta (o Supabase não cria nem
 * avisa ninguém): conta para o dono do e-mail como entrar ou recuperar a senha.
 */
export async function sendAccountExistsEmail(opts: { to: string }): Promise<MailResult> {
  const html = `<p>Olá.</p>
    <p>Alguém tentou criar uma conta na ${escapeHtml(env.brandName)} com este e-mail, mas ele já tem uma conta.</p>
    <p>Se foi você, é só entrar com a sua senha. Esqueceu? <a href="${env.siteUrl}/esqueci-senha?email=${encodeURIComponent(opts.to)}">Crie uma senha nova</a>.</p>
    <p>Se não foi você, pode ignorar: nada mudou na sua conta.</p>`;
  if (!hasResend) return { delivered: (await writeEmailFile(`conta-existe-${Date.now()}`, html)) ? 'file' : 'none' };
  try {
    const { data, error } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: opts.to,
      subject: `Você já tem uma conta — ${env.brandName}`,
      html,
    });
    if (!error) return { delivered: 'resend', ref: data?.id ?? null };
    console.error('[email] conta existente Resend falhou:', error.message);
  } catch (err) {
    console.error('[email] conta existente Resend falhou:', err);
  }
  return { delivered: 'none' };
}

/** Resposta da loja a um pedido de cancelamento recusado (o pedido segue normalmente). */
export async function sendCancelRequestAnswer(order: Order, response: string): Promise<MailResult> {
  const n = orderLabel(order.order_number);
  const html = `<p>Olá, ${escapeHtml(firstName(order.customer_name))}.</p>
    <p>Analisamos o seu pedido de cancelamento do pedido <strong>${n}</strong> e ele não pôde ser aprovado.</p>
    <p><strong>Resposta da loja:</strong> ${escapeHtml(response)}</p>
    <p>O pedido segue normalmente. Você também vê esta resposta em Minha conta › Pedidos. Dúvidas? Responda este e-mail.</p>`;
  return deliver(order.customer_email, `Sobre o cancelamento do pedido ${n} — ${env.brandName}`, html, `${order.order_number}-cancelamento-recusado-${Date.now()}`);
}

/** Aviso ao endereço novo quando um Administrador troca o e-mail de acesso de alguém da equipe. */
export async function sendTeamEmailChanged(opts: { to: string; name: string }): Promise<MailResult> {
  const html = `<p>Olá, ${escapeHtml(firstName(opts.name))}.</p>
    <p>O seu e-mail de acesso à equipe da ${escapeHtml(env.brandName)} agora é <strong>${escapeHtml(opts.to)}</strong>.</p>
    <p>Use este e-mail no próximo login. Se não reconhece esta mudança, fale com um Administrador.</p>`;
  if (!hasResend) return { delivered: (await writeEmailFile(`equipe-email-${Date.now()}`, html)) ? 'file' : 'none' };
  try {
    const { data, error } = await new Resend(env.resendApiKey).emails.send({
      from: env.resendFrom,
      to: opts.to,
      subject: `Seu e-mail de acesso foi alterado — ${env.brandName}`,
      html,
    });
    if (!error) return { delivered: 'resend', ref: data?.id ?? null };
    console.error('[email] troca de e-mail Resend falhou:', error.message);
  } catch (err) {
    console.error('[email] troca de e-mail Resend falhou:', err);
  }
  return { delivered: 'none' };
}
