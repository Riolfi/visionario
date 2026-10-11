import type { APIRoute } from 'astro';
import { lookupBarcode } from '../../../../lib/product-lookup';

/**
 * GET /api/admin/products/lookup?code=7891000100103
 * Dados públicos do produto pelo código de barras (nome, marca, descrição,
 * foto) pra pré-preencher o cadastro. Protegido como todo /api/admin.
 * Sempre 200: { found: false } ou { found: true, ...dados }.
 */
export const GET: APIRoute = async ({ url }) => {
  const result = await lookupBarcode(url.searchParams.get('code') || '');
  return new Response(JSON.stringify(result ? { found: true, ...result } : { found: false }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
