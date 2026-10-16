import type { APIRoute } from 'astro';
import { isValidEmail } from '../../lib/format';
import { sendContactMessage } from '../../lib/email';

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData().catch(() => null);
  const body = form
    ? Object.fromEntries(form)
    : ((await request.json().catch(() => ({}))) as Record<string, string>);

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const message = String(body.message || '').trim();
  // honeypot
  if (String(body.website || '')) return redirectDone(request);

  if (name.length < 2 || !isValidEmail(email) || message.length < 5) {
    return new Response(JSON.stringify({ error: 'Preencha nome, e-mail e mensagem.' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  // vai para o e-mail de atendimento da loja (o do remetente é nao-responda, sem caixa)
  await sendContactMessage({ name, email, phone, message, to: locals.site?.contact?.data?.email });
  return redirectDone(request);
};

function redirectDone(request: Request): Response {
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 303, headers: { location: '/contato?enviado=1' } });
}
