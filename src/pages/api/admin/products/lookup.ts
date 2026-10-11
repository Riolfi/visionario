import type { APIRoute } from 'astro';
import { lookupBarcode } from '../../../../lib/product-lookup';

/**
 * GET /api/admin/products/lookup?code=7891000100103
 * Dados públicos do produto pelo código de barras (nome, marca, descrição,
 * foto) pra pré-preencher o cadastro. Protegido como todo /api/admin.
 * Sempre 200: { found: true, ...dados } | { found: false, reason: 'not_found' | 'error' }.
 */
export const GET: APIRoute = async ({ url }) => {
  const result = await lookupBarcode(url.searchParams.get('code') || '');
  const body =
    result && result !== 'error' ? { found: true, ...result } : { found: false, reason: result === 'error' ? 'error' : 'not_found' };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
