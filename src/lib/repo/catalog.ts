import type { Category, CategoryNode, Product } from '../types';
import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { readCatalog, writeCatalog, type RawCatalog } from '../localstore';

export type SortKey = 'destaque' | 'preco-asc' | 'preco-desc' | 'vendidos' | 'novidades';

export interface ProductQuery {
  categorySlug?: string | null;
  sort?: SortKey;
  bestsellersOnly?: boolean;
  includeInactive?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

function sortProducts(list: Product[], sort: SortKey | undefined): Product[] {
  const arr = [...list];
  switch (sort) {
    case 'preco-asc':
      return arr.sort((a, b) => a.price_cents - b.price_cents);
    case 'preco-desc':
      return arr.sort((a, b) => b.price_cents - a.price_cents);
    case 'vendidos':
      return arr.sort((a, b) => b.reviews_count - a.reviews_count);
    case 'novidades':
      return arr.reverse();
    case 'destaque':
    default:
      return arr.sort(
        (a, b) => Number(b.is_bestseller) - Number(a.is_bestseller) || b.reviews_count - a.reviews_count,
      );
  }
}

// ---------------------------------------------------------------------------
// Fallback (arquivo JSON)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeCategory(row: any): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    position: row.position ?? 0,
    image_url: row.image_url ?? '',
    parent_id: row.parent_id ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** raiz → subcategoria, a partir do slug da subcategoria */
export function categoryPath(cats: Category[], subSlug: string): { slug: string; name: string }[] {
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const byId = new Map(cats.map((c) => [c.id, c]));
  const sub = bySlug.get(subSlug);
  if (!sub) return [];
  const parent = sub.parent_id ? byId.get(sub.parent_id) : null;
  const path: { slug: string; name: string }[] = [];
  if (parent) path.push({ slug: parent.slug, name: parent.name });
  path.push({ slug: sub.slug, name: sub.name });
  return path;
}

/** monta a árvore de 2 níveis a partir da lista plana */
export function toTree(cats: Category[]): CategoryNode[] {
  const roots = cats.filter((c) => !c.parent_id).sort((a, b) => a.position - b.position);
  return roots.map((r) => ({
    ...r,
    children: cats.filter((c) => c.parent_id === r.id).sort((a, b) => a.position - b.position),
  }));
}

function rawToCategories(raw: RawCatalog): Category[] {
  return [...raw.categories].map(normalizeCategory);
}

function rawToProducts(raw: RawCatalog): Product[] {
  const cats = rawToCategories(raw);
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  return raw.products.map((p) => {
    const cat = catBySlug.get(p.category_slug);
    return {
      ...p,
      category_id: cat?.id ?? '',
      category_name: cat?.name ?? '',
      category_path: categoryPath(cats, p.category_slug),
      barcode: p.barcode ?? null,
    } satisfies Product;
  });
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const PRODUCT_SELECT =
  '*, categories!inner(id, slug, name, parent:parent_id(slug, name))';

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToProduct(row: any): Product {
  const cat = row.categories ?? {};
  const parent = cat.parent ?? null;
  const path: { slug: string; name: string }[] = [];
  if (parent?.slug) path.push({ slug: parent.slug, name: parent.name });
  if (cat.slug) path.push({ slug: cat.slug, name: cat.name });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category_id: cat.id ?? row.category_id ?? '',
    category_slug: cat.slug ?? '',
    category_name: cat.name ?? '',
    category_path: path,
    short_description: row.short_description ?? '',
    description: row.description ?? '',
    ingredients: row.ingredients ?? '',
    how_to_use: row.how_to_use ?? '',
    price_cents: row.price_cents,
    compare_at_price_cents: row.compare_at_price_cents,
    stock: row.stock ?? 0,
    barcode: row.barcode ?? null,
    is_active: row.is_active ?? true,
    is_bestseller: row.is_bestseller ?? false,
    rating: row.rating,
    reviews_count: row.reviews_count ?? 0,
    images: Array.isArray(row.images) ? row.images : [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// API pública do repositório
// ---------------------------------------------------------------------------

export async function getCategories(): Promise<Category[]> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.from('categories').select('*').order('position');
    if (error) {
      console.warn('[catalog] categories via Supabase falhou, usando fallback:', error.message);
      return rawToCategories(await readCatalog());
    }
    return (data ?? []).map(normalizeCategory);
  }
  return rawToCategories(await readCatalog());
}

export async function getCategoryById(id: string): Promise<Category | null> {
  const all = await getCategories();
  return all.find((c) => c.id === id) ?? null;
}

/** raízes (nível 1) com suas subcategorias (nível 2) */
export async function getCategoryTree(): Promise<CategoryNode[]> {
  return toTree(await getCategories());
}

/** só as subcategorias (nível 2) — usado no formulário de produto */
export async function getSubcategories(): Promise<Category[]> {
  return (await getCategories()).filter((c) => c.parent_id);
}

export interface CategoryInput {
  id?: string;
  slug: string;
  name: string;
  description: string;
  image_url: string;
  /** só considerado ao CRIAR; a hierarquia depois é editada na lista (drag) */
  parent_id?: string | null;
}

export async function saveCategory(
  input: CategoryInput,
): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin();
  const isNew = !input.id;
  const base = {
    slug: input.slug,
    name: input.name,
    description: input.description,
    image_url: input.image_url,
  };

  if (hasSupabase && sb) {
    if (isNew) {
      const parent_id = input.parent_id || null;
      const { count } = await sb
        .from('categories')
        .select('id', { count: 'exact', head: true })
        .is('parent_id', parent_id === null ? null : (parent_id as never));
      const { error } = await sb.from('categories').insert({ ...base, parent_id, position: (count ?? 0) + 1 });
      return error ? { ok: false, error: error.message } : { ok: true };
    }
    const { error } = await sb.from('categories').update(base).eq('id', input.id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  const catalog = await readCatalog();
  if (input.id) {
    const idx = catalog.categories.findIndex((c) => c.id === input.id);
    if (idx < 0) return { ok: false, error: 'Categoria não encontrada.' };
    catalog.categories[idx] = { ...catalog.categories[idx], ...base };
  } else {
    const parent_id = input.parent_id || null;
    const siblings = catalog.categories.filter((c) => (c.parent_id ?? null) === parent_id);
    catalog.categories.push({ id: crypto.randomUUID(), ...base, parent_id, position: siblings.length + 1 });
  }
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

export interface TreeNodeInput {
  id: string;
  children?: { id: string }[];
}

/** grava parent_id + position de toda a árvore numa passada (editor de lista). */
export async function saveCategoryTree(
  nodes: TreeNodeInput[],
): Promise<{ ok: boolean; error?: string }> {
  const cats = await getCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));

  // valida: um nó com filhos não pode ser aninhado
  for (const root of nodes) {
    for (const child of root.children ?? []) {
      if (cats.some((c) => c.parent_id === child.id)) {
        return { ok: false, error: 'Uma categoria com subcategorias não pode virar subcategoria.' };
      }
    }
  }

  const updates: { id: string; parent_id: string | null; position: number }[] = [];
  nodes.forEach((root, ri) => {
    if (!byId.has(root.id)) return;
    updates.push({ id: root.id, parent_id: null, position: ri + 1 });
    (root.children ?? []).forEach((child, ci) => {
      if (byId.has(child.id)) updates.push({ id: child.id, parent_id: root.id, position: ci + 1 });
    });
  });

  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    for (const u of updates) {
      const { error } = await sb
        .from('categories')
        .update({ parent_id: u.parent_id, position: u.position })
        .eq('id', u.id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  const catalog = await readCatalog();
  const patch = new Map(updates.map((u) => [u.id, u]));
  catalog.categories = catalog.categories.map((c) => {
    const u = patch.get(c.id);
    return u ? { ...c, parent_id: u.parent_id, position: u.position } : c;
  });
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

export async function deleteCategory(id: string): Promise<{ ok: boolean; error?: string }> {
  const cats = await getCategories();
  if (cats.some((c) => c.parent_id === id)) {
    return { ok: false, error: 'Esta categoria tem subcategorias. Remova-as antes.' };
  }
  const cat = cats.find((c) => c.id === id);
  const products = await getProducts({ includeInactive: true });
  if (cat && products.some((p) => p.category_slug === cat.slug)) {
    return { ok: false, error: 'Há produtos nesta subcategoria. Mova-os antes de excluir.' };
  }
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('categories').delete().eq('id', id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const catalog = await readCatalog();
  catalog.categories = catalog.categories.filter((c) => c.id !== id);
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

/** slugs de subcategoria correspondentes a um slug (raiz → suas subs; sub → ela). */
async function resolveCategorySlugs(slug: string): Promise<string[]> {
  const cats = await getCategories();
  const target = cats.find((c) => c.slug === slug);
  if (!target) return [slug];
  if (target.parent_id) return [target.slug];
  const children = cats.filter((c) => c.parent_id === target.id);
  // raiz sem filhos (dados planos antigos) → comporta como folha
  return children.length ? children.map((c) => c.slug) : [target.slug];
}

export async function getProducts(query: ProductQuery = {}): Promise<Product[]> {
  const { categorySlug, sort, bestsellersOnly, includeInactive, limit } = query;
  const sb = supabaseAdmin();
  const slugs = categorySlug ? await resolveCategorySlugs(categorySlug) : null;

  if (hasSupabase && sb) {
    let q = sb.from('products').select(PRODUCT_SELECT);
    if (!includeInactive) q = q.eq('is_active', true);
    if (bestsellersOnly) q = q.eq('is_bestseller', true);
    if (slugs) q = q.in('categories.slug', slugs);
    const { data, error } = await q;
    if (error) throw error;
    let products = (data ?? []).map(rowToProduct).filter((p) => p.category_slug);
    products = sortProducts(products, sort);
    return limit ? products.slice(0, limit) : products;
  }

  let products = rawToProducts(await readCatalog());
  if (!includeInactive) products = products.filter((p) => p.is_active);
  if (bestsellersOnly) products = products.filter((p) => p.is_bestseller);
  if (slugs) products = products.filter((p) => slugs.includes(p.category_slug));
  products = sortProducts(products, sort);
  return limit ? products.slice(0, limit) : products;
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.from('products').select(PRODUCT_SELECT).eq('slug', slug).maybeSingle();
    if (error) throw error;
    return data ? rowToProduct(data) : null;
  }
  const products = rawToProducts(await readCatalog());
  return products.find((p) => p.slug === slug) ?? null;
}

export async function getProductById(id: string): Promise<Product | null> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.from('products').select(PRODUCT_SELECT).eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? rowToProduct(data) : null;
  }
  const products = rawToProducts(await readCatalog());
  return products.find((p) => p.id === id) ?? null;
}

/** Busca por EAN/UPC lido no leitor de código de barras (cadastro e, depois, Caixa). */
export async function getProductByBarcode(barcode: string): Promise<Product | null> {
  const code = barcode.trim();
  if (!code) return null;
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.from('products').select(PRODUCT_SELECT).eq('barcode', code).maybeSingle();
    if (error) throw error;
    return data ? rowToProduct(data) : null;
  }
  const products = rawToProducts(await readCatalog());
  return products.find((p) => p.barcode === code) ?? null;
}

export async function getRelatedProducts(product: Product, limit = 4): Promise<Product[]> {
  const all = await getProducts({ categorySlug: product.category_slug });
  const sameCat = all.filter((p) => p.id !== product.id);
  if (sameCat.length >= limit) return sameCat.slice(0, limit);
  const others = (await getProducts({ sort: 'destaque' })).filter(
    (p) => p.id !== product.id && !sameCat.some((s) => s.id === p.id),
  );
  return [...sameCat, ...others].slice(0, limit);
}

export async function getBestsellers(limit = 4): Promise<Product[]> {
  const list = await getProducts({ bestsellersOnly: true, sort: 'vendidos' });
  if (list.length >= limit) return list.slice(0, limit);
  const fill = (await getProducts({ sort: 'vendidos' })).filter((p) => !list.some((l) => l.id === p.id));
  return [...list, ...fill].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Escrita (admin)
// ---------------------------------------------------------------------------

export interface ProductInput {
  id?: string;
  slug: string;
  name: string;
  category_id: string;
  short_description: string;
  description: string;
  ingredients: string;
  how_to_use: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  stock: number;
  barcode?: string | null;
  is_active: boolean;
  is_bestseller: boolean;
  images: string[];
}

export async function saveProduct(
  input: ProductInput,
): Promise<{ ok: true; id?: string } | { ok: false; error: string; code?: 'barcode_dup' }> {
  const sb = supabaseAdmin();
  const barcode = input.barcode?.trim() || null;

  if (barcode) {
    const dupe = await getProductByBarcode(barcode);
    if (dupe && dupe.id !== input.id) {
      return { ok: false, code: 'barcode_dup', error: 'Código de barras já cadastrado em outro produto.' };
    }
  }

  if (hasSupabase && sb) {
    const payload = { ...input, barcode, updated_at: new Date().toISOString() };
    const { data, error } = input.id
      ? await sb.from('products').update(payload).eq('id', input.id).select('id').single()
      : await sb.from('products').insert(payload).select('id').single();
    if (error) {
      // corrida: outro cadastro levou o mesmo código entre a conferência e o insert (único no banco)
      if (/barcode/i.test(error.message) && /duplicate|unique/i.test(error.message)) {
        return { ok: false, code: 'barcode_dup', error: 'Código de barras já cadastrado em outro produto.' };
      }
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data.id };
  }

  // Fallback: edita o catalog.json local
  const catalog = await readCatalog();
  const cat = catalog.categories.find((c) => c.id === input.category_id);
  if (!cat) return { ok: false, error: 'Categoria inválida.' };
  const record = {
    id: input.id ?? crypto.randomUUID(),
    slug: input.slug,
    name: input.name,
    category_slug: cat.slug,
    short_description: input.short_description,
    description: input.description,
    ingredients: input.ingredients,
    how_to_use: input.how_to_use,
    price_cents: input.price_cents,
    compare_at_price_cents: input.compare_at_price_cents,
    stock: input.stock,
    barcode,
    is_active: input.is_active,
    is_bestseller: input.is_bestseller,
    rating: null,
    reviews_count: 0,
    images: input.images,
  };
  const idx = catalog.products.findIndex((p) => p.id === record.id);
  if (idx >= 0) catalog.products[idx] = { ...catalog.products[idx], ...record };
  else catalog.products.push(record);
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/ (filesystem somente-leitura?).' };
}

export async function deleteProduct(id: string): Promise<{ ok: boolean; error?: string; inUse?: boolean }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('products').delete().eq('id', id);
    // 23503 = FK: o produto está em order_items (já foi vendido) — o histórico
    // de pedidos precisa dele, então não pode sumir do banco
    if (error?.code === '23503') return { ok: false, inUse: true, error: 'Este produto já tem pedidos e não pode ser excluído.' };
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const catalog = await readCatalog();
  catalog.products = catalog.products.filter((p) => p.id !== id);
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

/** Tira o produto da loja sem apagar (para produto que já tem pedidos). */
export async function deactivateProduct(id: string): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('products').update({ is_active: false }).eq('id', id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const catalog = await readCatalog();
  const p = catalog.products.find((x) => x.id === id);
  if (p) p.is_active = false;
  const wrote = await writeCatalog(catalog);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}
