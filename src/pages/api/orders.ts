import type { APIRoute } from 'astro';
import { createOrder, priceCart } from '../../lib/repo/orders';
import { calcShipping } from '../../lib/shipping';
import { isValidCep, isValidCpf, isValidEmail, isValidPhone, onlyDigits } from '../../lib/format';
import { sendOrderStatusEmail } from '../../lib/email';
import type { ShippingAddress } from '../../lib/types';

interface Body {
  customer?: { name?: string; email?: string; phone?: string; cpf?: string };
  shipping?: Partial<ShippingAddress>;
  items?: { product_id?: string; quantity?: number }[];
}

export const POST: APIRoute = async ({ request, locals }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: 'Requisição inválida.' }, 400);
  }

  const name = (body.customer?.name || '').trim();
  const email = (body.customer?.email || '').trim().toLowerCase();
  const phone = (body.customer?.phone || '').trim();
  const cpf = onlyDigits(body.customer?.cpf || '');
  const cep = onlyDigits(body.shipping?.cep || '');

  const uf = (body.shipping?.state || '').trim().toUpperCase();

  const errors: string[] = [];
  if (name.length < 3 || !/\s/.test(name)) errors.push('Informe o nome e o sobrenome.');
  if (!isValidEmail(email)) errors.push('E-mail inválido.');
  if (!isValidCpf(cpf)) errors.push('CPF inválido.');
  if (!isValidPhone(phone)) errors.push('Telefone inválido (com DDD).');
  if (!isValidCep(cep)) errors.push('CEP inválido.');
  if (!body.shipping?.street?.trim()) errors.push('Informe a rua.');
  if (!body.shipping?.number?.trim()) errors.push('Informe o número (use "s/n" se não houver).');
  if (!body.shipping?.district?.trim()) errors.push('Informe o bairro.');
  if (!body.shipping?.city?.trim()) errors.push('Informe a cidade.');
  if (!/^[A-Z]{2}$/.test(uf)) errors.push('Informe a UF (2 letras).');

  const rawItems = (body.items || [])
    .filter((i): i is { product_id: string; quantity: number } => Boolean(i.product_id))
    .map((i) => ({ product_id: i.product_id, quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)) }));
  if (!rawItems.length) errors.push('Carrinho vazio.');

  if (errors.length) return json({ error: errors.join(' ') }, 422);

  try {
    const { subtotalCents } = await priceCart(rawItems);
    const quote = calcShipping(cep, subtotalCents);
    if (!quote) return json({ error: 'Não foi possível calcular o frete para esse CEP.' }, 422);

    const address: ShippingAddress = {
      cep,
      street: body.shipping!.street!.trim(),
      number: body.shipping!.number!.trim(),
      complement: (body.shipping!.complement || '').trim(),
      district: body.shipping!.district!.trim(),
      city: body.shipping!.city!.trim(),
      state: uf,
    };

    const order = await createOrder({
      customer: { name, email, phone, cpf },
      shipping: address,
      shipping_cents: quote.cents,
      items: rawItems,
      userId: locals.user?.id ?? null,
    });

    sendOrderStatusEmail(order, 'pending').catch(() => {});

    return json({
      id: order.id,
      order_number: order.order_number,
      subtotal_cents: order.subtotal_cents,
      shipping_cents: order.shipping_cents,
      shipping_label: quote.label,
      total_cents: order.total_cents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao criar o pedido.';
    return json({ error: message }, 422);
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
