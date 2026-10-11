import type { APIRoute } from 'astro';
import { getOrderById } from '../../../lib/repo/orders';

// Público (checkout e Caixa consultam enquanto o Pix não compensa): busca
// pelo uuid do pedido, nunca pelo número exibido (#13453), que é adivinhável.
export const GET: APIRoute = async ({ url }) => {
  const order = await getOrderById(url.searchParams.get('id') || '');
  if (!order) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      status: order.status,
      redirect: order.status === 'paid' ? `/pedido/confirmado?id=${order.id}` : null,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
