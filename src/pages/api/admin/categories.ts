import type { APIRoute } from 'astro';
import {
  saveCategory,
  deleteCategory,
  saveCategoryTree,
  type CategoryInput,
  type TreeNodeInput,
} from '../../../lib/repo/catalog';
import { slugify } from '../../../lib/format';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request, url }) => {
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) return json({ error: 'JSON inválido.' }, 400);

  if (url.searchParams.get('action') === 'tree') {
    const nodes = Array.isArray(raw.nodes)
      ? (raw.nodes as any[]).map(
          (nd): TreeNodeInput => ({
            id: String(nd.id),
            children: Array.isArray(nd.children)
              ? nd.children.map((c: any) => ({ id: String(c.id) }))
              : [],
          }),
        )
      : [];
    if (!nodes.length) return json({ error: 'árvore vazia.' }, 422);
    const result = await saveCategoryTree(nodes);
    return result.ok ? json({ ok: true }) : json({ error: result.error }, 422);
  }

  const name = String(raw.name || '').trim();
  if (name.length < 2) return json({ error: 'Nome obrigatório.' }, 422);

  const input: CategoryInput = {
    id: raw.id ? String(raw.id) : undefined,
    slug: String(raw.slug || '').trim() || slugify(name),
    name,
    description: String(raw.description || '').trim(),
    image_url: String(raw.image_url || '').trim(),
    is_active: raw.is_active !== false,
    parent_id: raw.parent_id ? String(raw.parent_id) : null,
  };

  const result = await saveCategory(input);
  return result.ok ? json({ ok: true, id: result.id }) : json({ error: result.error }, 500);
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const id = url.searchParams.get('id') || (await request.json().catch(() => ({})))?.id;
  if (!id) return json({ error: 'id obrigatório.' }, 400);
  const result = await deleteCategory(String(id));
  return result.ok ? json({ ok: true }) : json({ error: result.error }, 422);
};
