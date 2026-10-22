import type { APIRoute } from 'astro';
import { getOrderByNumber } from '../../../../lib/repo/orders';
import { setFlash } from '../../../../lib/flash';
import { can } from '../../../../lib/rbac';
import { orderLabel } from '../../../../lib/format';
import { approveReturn, completeReturn, exchangeFromForm, rejectReturn, restockFromForm } from '../../../../lib/order-policy';

/**
 * POST /api/admin/orders/devolucao — troca ou devolução pedida pelo cliente
 * (regra pedidos.cancelar). order_number e acao:
 *  - aprovar:  codigo_postagem (opcional), instrucoes → cliente recebe por e-mail;
 *  - recusar:  resposta obrigatória → cliente recebe por e-mail;
 *  - concluir: itens já na loja (Confirmação de troca ou devolução):
 *              resolucao=reembolso|troca, restock_<product_id> (o resto é
 *              perda), na troca troca_product_<n>/troca_qty_<n>.
 */
export const POST: APIRoute = async ({ request, cookies, redirect, locals }) => {
  const form = await request.formData();
  const number = String(form.get('order_number') || '').trim();
  const back = `/admin/pedidos/${number}`;
  const done = (ok: boolean, text: string) => {
    setFlash(cookies, ok ? 'ok' : 'erro', text);
    return redirect(back);
  };
  if (!can(locals.admin, 'pedidos.cancelar')) return done(false, 'Seu cargo não permite cuidar de trocas e devoluções.');
  const order = number ? await getOrderByNumber(number) : null;
  if (!order) return redirect('/admin/pedidos');
  const by = locals.user?.id ?? null;
  const acao = String(form.get('acao') || '');

  if (acao === 'aprovar') {
    const postCode = String(form.get('codigo_postagem') || '').trim().slice(0, 40) || null;
    const instructions = String(form.get('instrucoes') || '').trim();
    if (instructions.length < 5) return done(false, 'Escreva as instruções de devolução para o cliente.');
    const r = await approveReturn(order, by, postCode, instructions);
    return done(r.ok, r.ok ? 'Pedido aprovado. O cliente recebeu por e-mail como devolver os itens.' : r.error);
  }

  if (acao === 'recusar') {
    const response = String(form.get('resposta') || '').trim();
    if (response.length < 5) return done(false, 'Escreva a resposta ao cliente (por que o pedido foi recusado).');
    const r = await rejectReturn(order, by, response);
    return done(r.ok, r.ok ? 'Pedido recusado. O cliente recebeu a resposta por e-mail.' : r.error);
  }

  if (acao === 'concluir') {
    const resolution = form.get('resolucao') === 'troca' ? 'troca' : 'reembolso';
    const r = await completeReturn(order, by, { resolution, restock: restockFromForm(form), exchange: exchangeFromForm(form) });
    if (!r.ok) return done(false, r.error);
    if (r.exchangeNumber) return done(true, `Troca concluída. O pedido de reenvio ${orderLabel(r.exchangeNumber)} foi criado como Pago: separe e envie por ele. O estoque foi atualizado e o cliente foi avisado por e-mail.`);
    const refund = r.refundedCents ? (r.simulated ? ' (pagamento de teste: nada a estornar)' : ' O valor total (produtos + frete) foi estornado pelo Mercado Pago.') : '';
    return done(true, `Devolução concluída.${refund} O estoque foi atualizado (o que não voltou ficou como perda) e o cliente foi avisado por e-mail.`);
  }

  return redirect(back);
};
