import { useState } from 'preact/hooks';
import CameraScanButton from './CameraScanButton';
import type { CategoryNode, Product } from '../lib/types';

interface Props {
  product: Product | null;
  /** árvore de categorias — o produto é vinculado a uma subcategoria (nível 2) */
  tree: CategoryNode[];
  /** código de barras já lido antes de chegar aqui (veio de um scan sem produto encontrado) */
  initialBarcode?: string;
}

export default function AdminProductForm({ product, tree, initialBarcode }: Props) {
  const firstSub = tree.flatMap((r) => r.children)[0]?.id ?? '';
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [urlInput, setUrlInput] = useState('');
  const [form, setForm] = useState({
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    category_id: product?.category_id ?? firstSub,
    short_description: product?.short_description ?? '',
    description: product?.description ?? '',
    ingredients: product?.ingredients ?? '',
    how_to_use: product?.how_to_use ?? '',
    price: product ? (product.price_cents / 100).toFixed(2) : '',
    compare_at: product?.compare_at_price_cents ? (product.compare_at_price_cents / 100).toFixed(2) : '',
    stock: product ? String(product.stock) : '0',
    barcode: product?.barcode ?? initialBarcode ?? '',
    is_active: product?.is_active ?? true,
    is_bestseller: product?.is_bestseller ?? false,
  });

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function addUrl() {
    const url = urlInput.trim();
    if (url && !images.includes(url)) setImages((list) => [...list, url]);
    setUrlInput('');
  }

  function removeImage(url: string) {
    setImages((list) => list.filter((u) => u !== url));
  }

  function moveImage(i: number, dir: -1 | 1) {
    setImages((list) => {
      const next = [...list];
      const j = i + dir;
      if (j < 0 || j >= next.length) return list;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  async function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no upload.');
      setImages((list) => [...list, ...data.urls.filter((u: string) => !list.includes(u))]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no upload.');
    } finally {
      setUploading(false);
      input.value = '';
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: product?.id,
          name: form.name,
          slug: form.slug,
          category_id: form.category_id,
          short_description: form.short_description,
          description: form.description,
          ingredients: form.ingredients,
          how_to_use: form.how_to_use,
          price_cents: Math.round(parseFloat(form.price.replace(',', '.')) * 100),
          compare_at_price_cents: form.compare_at
            ? Math.round(parseFloat(form.compare_at.replace(',', '.')) * 100)
            : null,
          stock: parseInt(form.stock, 10) || 0,
          barcode: form.barcode.trim() || null,
          is_active: form.is_active,
          is_bestseller: form.is_bestseller,
          images,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar.');
      window.location.href = '/admin/produtos';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!product || !confirm(`Excluir "${product.name}"?`)) return;
    setSaving(true);
    const res = await fetch(`/api/admin/products?id=${product.id}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/admin/produtos';
    else {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'Erro ao excluir.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} class="max-w-2xl space-y-5">
      {error && <p class="rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block sm:col-span-2">
          <span class="label">Nome</span>
          <input class="field" value={form.name} onInput={(e) => upd('name', (e.target as HTMLInputElement).value)} required />
        </label>
        <label class="block">
          <span class="label">Slug (URL)</span>
          <input class="field" value={form.slug} placeholder="gerado do nome se vazio" onInput={(e) => upd('slug', (e.target as HTMLInputElement).value)} />
        </label>
        <label class="block">
          <span class="label">Subcategoria</span>
          <select class="field" value={form.category_id} onChange={(e) => upd('category_id', (e.target as HTMLSelectElement).value)} required>
            {tree.length === 0 && <option value="">— crie categorias primeiro —</option>}
            {tree.map((root) => (
              <optgroup label={root.name}>
                {root.children.length === 0 && <option disabled>(sem subcategorias)</option>}
                {root.children.map((sub) => <option value={sub.id}>{sub.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label class="block">
          <span class="label">Preço (R$)</span>
          <input class="field" inputMode="decimal" value={form.price} onInput={(e) => upd('price', (e.target as HTMLInputElement).value)} required />
        </label>
        <label class="block">
          <span class="label">Preço "de" / comparação (R$)</span>
          <input class="field" inputMode="decimal" value={form.compare_at} onInput={(e) => upd('compare_at', (e.target as HTMLInputElement).value)} />
        </label>
        <label class="block">
          <span class="label">Estoque</span>
          <input class="field" inputMode="numeric" value={form.stock} onInput={(e) => upd('stock', (e.target as HTMLInputElement).value)} />
        </label>
        <div class="block">
          <div class="flex items-center justify-between gap-2">
            <label class="label" for="product-barcode">Código de barras</label>
            <CameraScanButton onCode={(code) => upd('barcode', code)} />
          </div>
          <input
            id="product-barcode"
            class="field"
            inputMode="numeric"
            placeholder="passe o leitor aqui, ou digite"
            value={form.barcode}
            onInput={(e) => upd('barcode', (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              // o leitor "digita" o código e um Enter — não deixa isso enviar o form sozinho
              if (e.key === 'Enter') e.preventDefault();
            }}
          />
        </div>
      </div>

      <label class="block">
        <span class="label">Descrição curta</span>
        <input class="field" value={form.short_description} onInput={(e) => upd('short_description', (e.target as HTMLInputElement).value)} />
      </label>
      <label class="block">
        <span class="label">Descrição completa</span>
        <textarea class="field" rows={4} value={form.description} onInput={(e) => upd('description', (e.target as HTMLTextAreaElement).value)} />
      </label>
      <label class="block">
        <span class="label">Material</span>
        <textarea class="field" rows={3} value={form.ingredients} onInput={(e) => upd('ingredients', (e.target as HTMLTextAreaElement).value)} />
      </label>
      <label class="block">
        <span class="label">Cuidados</span>
        <textarea class="field" rows={3} value={form.how_to_use} onInput={(e) => upd('how_to_use', (e.target as HTMLTextAreaElement).value)} />
      </label>
      <div>
        <span class="label">Imagens do produto</span>
        <p class="mb-2 text-[12px] text-ink-muted">
          A primeira imagem é a capa. Envie arquivos do computador ou cole links —
          o que estiver na lista abaixo é o que vai para a loja.
        </p>

        {images.length > 0 && (
          <ul class="mb-3 grid grid-cols-3 gap-3 sm:grid-cols-4">
            {images.map((url, i) => (
              <li key={url} class="group relative overflow-hidden rounded-card border border-ink/10 bg-bone-100">
                <img src={url} alt="" class="aspect-square w-full object-cover" loading="lazy" />
                {i === 0 && (
                  <span class="absolute left-1 top-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] uppercase text-bone">Capa</span>
                )}
                <div class="absolute inset-x-0 bottom-0 flex justify-between bg-ink/70 p-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button type="button" class="px-1 text-bone disabled:opacity-30" onClick={() => moveImage(i, -1)} disabled={i === 0} aria-label="Mover para a esquerda">‹</button>
                  <button type="button" class="px-1 text-bone" onClick={() => removeImage(url)} aria-label="Remover">✕</button>
                  <button type="button" class="px-1 text-bone disabled:opacity-30" onClick={() => moveImage(i, 1)} disabled={i === images.length - 1} aria-label="Mover para a direita">›</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div class="flex flex-wrap items-center gap-3">
          <label class="btn-outline cursor-pointer text-[13px]">
            {uploading ? 'Enviando…' : 'Enviar do computador'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple class="hidden" onChange={onFiles} disabled={uploading} />
          </label>
          <span class="text-[12px] text-ink-muted">JPG, PNG, WebP ou AVIF · até 5 MB cada</span>
        </div>

        <div class="mt-2 flex gap-2">
          <input
            class="field text-[13px]"
            placeholder="ou cole uma URL de imagem e clique em Adicionar"
            value={urlInput}
            onInput={(e) => setUrlInput((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
          />
          <button type="button" class="btn-outline shrink-0 text-[13px]" onClick={addUrl}>Adicionar</button>
        </div>
      </div>

      <div class="flex gap-6">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_active} onChange={(e) => upd('is_active', (e.target as HTMLInputElement).checked)} />
          Ativo (visível na loja)
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_bestseller} onChange={(e) => upd('is_bestseller', (e.target as HTMLInputElement).checked)} />
          Mais vendido
        </label>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button type="submit" class="btn-primary" disabled={saving}>
          {saving ? 'Salvando…' : product ? 'Salvar alterações' : 'Criar produto'}
        </button>
        <a href="/admin/produtos" class="btn-outline">Cancelar</a>
        {product && (
          <button type="button" onClick={remove} class="ml-auto text-sm text-red-700 hover:underline" disabled={saving}>
            Excluir
          </button>
        )}
      </div>
    </form>
  );
}
