import type { APIRoute } from 'astro';
import { saveOffer, deleteOffer, reorderOffers, type OfferInput } from '../../../lib/repo/site';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request, url }) => {
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return json({ error: 'JSON inválido.' }, 400);

  if (url.searchParams.get('action') === 'reorder') {
    const ids = Array.isArray(raw.ids) ? raw.ids.map(String) : [];
    if (!ids.length) return json({ error: 'ids obrigatórios.' }, 422);
    await reorderOffers(ids);
    return json({ ok: true });
  }

  const title = String(raw.title || '').trim();
  if (!title) return json({ error: 'O título é obrigatório.' }, 422);

  const input: OfferInput = {
    id: raw.id ? String(raw.id) : undefined,
    is_active: raw.is_active !== false,
    image_url: String(raw.image_url || '').trim(),
    eyebrow: String(raw.eyebrow || '').trim(),
    title,
    subtitle: String(raw.subtitle || '').trim(),
    cta_label: String(raw.cta_label || '').trim(),
    cta_href: String(raw.cta_href || '').trim(),
  };

  const result = await saveOffer(input);
  return result.ok ? json({ ok: true, id: result.id }) : json({ error: result.error }, 500);
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const id = url.searchParams.get('id') || (await request.json().catch(() => ({})))?.id;
  if (!id) return json({ error: 'id obrigatório.' }, 400);
  const result = await deleteOffer(String(id));
  return result.ok ? json({ ok: true }) : json({ error: result.error }, 500);
};
