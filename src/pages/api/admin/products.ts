import type { APIRoute } from 'astro';
import {
  saveProduct,
  deleteProduct,
  getSubcategories,
  type ProductInput,
} from '../../../lib/repo/catalog';
import { slugify } from '../../../lib/format';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function parseInput(raw: Record<string, unknown>): { ok: true; value: ProductInput } | { ok: false; error: string } {
  const name = String(raw.name || '').trim();
  const category_id = String(raw.category_id || '').trim();
  if (name.length < 2) return { ok: false, error: 'Nome obrigatório.' };
  if (!category_id) return { ok: false, error: 'Categoria obrigatória.' };

  // obrigatórios no cadastro (mesma regra do formulário)
  if (!String(raw.barcode || '').trim()) return { ok: false, error: 'Código de barras obrigatório.' };
  if (!String(raw.short_description || '').trim()) return { ok: false, error: 'Marca obrigatória.' };
  if (!String(raw.description || '').trim()) return { ok: false, error: 'Descrição completa obrigatória.' };

  const price_cents = Math.round(Number(raw.price_cents) || 0);
  if (price_cents <= 0) return { ok: false, error: 'Preço inválido.' };

  const compareRaw = Number(raw.compare_at_price_cents);
  const compare_at_price_cents = Number.isFinite(compareRaw) && compareRaw > 0 ? Math.round(compareRaw) : null;
  // com oferta, o preço cheio (compare_at) tem que ser maior que o cobrado
  if (compare_at_price_cents !== null && compare_at_price_cents <= price_cents) {
    return { ok: false, error: 'A oferta precisa ser menor que o preço.' };
  }

  const images = Array.isArray(raw.images)
    ? raw.images.map((s) => String(s).trim()).filter(Boolean)
    : String(raw.images || '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

  return {
    ok: true,
    value: {
      id: raw.id ? String(raw.id) : undefined,
      slug: String(raw.slug || '').trim() || slugify(name),
      name,
      category_id,
      short_description: String(raw.short_description || '').trim(),
      description: String(raw.description || '').trim(),
      ingredients: String(raw.ingredients || '').trim(),
      how_to_use: String(raw.how_to_use || '').trim(),
      price_cents,
      compare_at_price_cents,
      stock: Math.max(0, Math.round(Number(raw.stock) || 0)),
      barcode: String(raw.barcode || '').trim() || null,
      is_active: raw.is_active === true || raw.is_active === 'on' || raw.is_active === 'true',
      is_bestseller: raw.is_bestseller === true || raw.is_bestseller === 'on' || raw.is_bestseller === 'true',
      images,
    },
  };
}

export const POST: APIRoute = async ({ request }) => {
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return json({ error: 'JSON inválido.' }, 400);

  const parsed = parseInput(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 422);

  const subs = await getSubcategories();
  if (!subs.some((s) => s.id === parsed.value.category_id)) {
    return json({ error: 'O produto deve pertencer a uma subcategoria (nível 2).' }, 422);
  }

  const result = await saveProduct(parsed.value);
  if (!result.ok) return json({ error: result.error }, 500);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const id = url.searchParams.get('id') || (await request.json().catch(() => ({})))?.id;
  if (!id) return json({ error: 'id obrigatório.' }, 400);
  const result = await deleteProduct(String(id));
  if (!result.ok) return json({ error: result.error }, 500);
  return json({ ok: true });
};
