import { useEffect, useRef, useState } from 'preact/hooks';
import CameraScanButton from './CameraScanButton';
import { confirmDialog } from '../lib/confirm-dialog';
import type { CategoryNode, Product } from '../lib/types';

interface Props {
  product: Product | null;
  /** árvore de categorias — o produto é vinculado a uma subcategoria (nível 2) */
  tree: CategoryNode[];
  /** código de barras já lido antes de chegar aqui (veio de um scan sem produto encontrado) */
  initialBarcode?: string;
}

/** Máscara de dinheiro: "8990" → "89,90", "123456" → "1.234,56".
 *  Digita-se só números, da direita pra esquerda (como em maquininha). */
function maskMoney(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9);
  if (!digits) return '';
  const cents = digits.padStart(3, '0');
  const int = cents.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${int},${cents.slice(-2)}`;
}
const moneyToCents = (masked: string) => Number(masked.replace(/\D/g, '') || '0');

export default function AdminProductForm({ product, tree, initialBarcode }: Props) {
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [urlInput, setUrlInput] = useState('');
  const [form, setForm] = useState({
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    // produto novo começa sem categoria — o admin escolhe (obrigatório no envio)
    category_id: product?.category_id ?? '',
    short_description: product?.short_description ?? '',
    description: product?.description ?? '',
    ingredients: product?.ingredients ?? '',
    how_to_use: product?.how_to_use ?? '',
    // preços guardados já mascarados ("1.234,56"); o R$ fica fixo na frente do campo
    price: product ? maskMoney(String(product.price_cents)) : '',
    compare_at: product?.compare_at_price_cents ? maskMoney(String(product.compare_at_price_cents)) : '',
    stock: product ? String(product.stock) : '0',
    barcode: product?.barcode ?? initialBarcode ?? '',
    is_active: product?.is_active ?? true,
    is_bestseller: product?.is_bestseller ?? false,
  });

  const formRef = useRef(form);
  formRef.current = form;
  // código a que os dados da tela pertencem (o salvo, ou o último buscado) e
  // se nome/marca/descrição vieram da busca — ver lookupCode
  const baseCode = useRef<string | null>(product?.barcode?.replace(/\D/g, '') || null);
  const autoFilled = useRef(false);

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // ---- busca do produto pelo código de barras (bases públicas) ------------
  // Preenche nome, marca e descrição: só o que estiver vazio quando é o mesmo
  // produto; sobrescreve quando o admin bipa OUTRO produto. A foto vira
  // sugestão pra aceitar. Nunca mexe em preço/estoque/categoria.
  type Found = { source: string; name: string; brand: string | null; description: string | null; image: string | null };
  const [lookup, setLookup] = useState<
    | { state: 'idle' }
    | { state: 'busy' }
    | { state: 'none' }
    | { state: 'error' }
    | { state: 'found'; data: Found; filled: string[] }
  >({ state: 'idle' });

  /** Plano B: o próprio navegador consulta as bases Open Facts (liberam CORS)
   *  — cobre o caso de o servidor não conseguir falar com elas. */
  async function lookupInBrowser(code: string): Promise<Found | null> {
    const hosts = ['world.openfoodfacts.org', 'world.openbeautyfacts.org', 'world.openproductsfacts.org'];
    const fields = 'product_name_pt,product_name,generic_name_pt,generic_name,brands,quantity,image_front_url';
    const tries = await Promise.all(
      hosts.map(async (h) => {
        try {
          const r = await fetch(`https://${h}/api/v2/product/${code}.json?fields=${fields}`, { signal: AbortSignal.timeout(5000) });
          const d = r.ok ? await r.json() : null;
          const p = d?.status === 1 ? d.product : null;
          const name = (p?.product_name_pt || p?.product_name || '').trim();
          if (!name) return null;
          const qty = (p.quantity || '').trim();
          const generic = (p.generic_name_pt || p.generic_name || '').trim();
          return {
            source: h.split('.')[1]!,
            name: qty && !name.includes(qty) ? `${name} ${qty}` : name,
            brand: (p.brands || '').split(',')[0]?.trim() || null,
            description: generic && generic.toLowerCase() !== name.toLowerCase() ? generic : null,
            image: p.image_front_url || null,
          } as Found;
        } catch {
          return null;
        }
      }),
    );
    return tries.find(Boolean) ?? null;
  }

  async function lookupCode(raw: string) {
    const code = raw.replace(/\D/g, '');
    if (code.length < 8) return;
    setLookup({ state: 'busy' });
    try {
      let data: ({ found: boolean; reason?: string } & Found) | null = null;
      try {
        const res = await fetch(`/api/admin/products/lookup?code=${code}`);
        if (res.ok) data = await res.json();
      } catch {
        /* cai no plano B */
      }
      if (!data?.found) {
        const viaBrowser = await lookupInBrowser(code);
        if (viaBrowser) data = { found: true, ...viaBrowser };
      }
      if (!data?.found) {
        if (!data || data.reason === 'error') {
          // nem o servidor nem o navegador conseguiram consultar
          return setLookup({ state: 'error' });
        }
        // bipou outro produto que não está nas bases: tira os dados do anterior
        if (code !== baseCode.current && autoFilled.current) {
          setForm((cur) => ({ ...cur, name: '', short_description: '', description: '' }));
        }
        baseCode.current = code;
        autoFilled.current = false;
        return setLookup({ state: 'none' });
      }
      autoFilled.current = true;
      // Bipou OUTRO produto (código diferente do salvo/último buscado):
      // sobrescreve nome, marca e descrição com o novo. Mesmo código de
      // novo (ex.: editando um produto já cadastrado): só preenche o vazio.
      const overwrite = code !== baseCode.current;
      baseCode.current = code;
      const f = formRef.current; // o que está na tela AGORA
      const patch: Partial<typeof form> = {};
      const filled: string[] = [];
      const put = (k: 'name' | 'short_description' | 'description', v: string | null, label: string) => {
        if ((overwrite || !f[k].trim()) && (v || overwrite)) (patch[k] = v ?? ''), v && filled.push(label);
      };
      put('name', data.name, 'nome');
      put('short_description', data.brand, 'marca');
      put('description', data.description, 'descrição');
      setForm((cur) => ({ ...cur, ...patch }));
      setLookup({ state: 'found', data, filled });
    } catch {
      setLookup({ state: 'error' });
    }
  }

  // cadastro novo vindo do leitor (?barcode=): já busca ao abrir
  useEffect(() => {
    if (!product && initialBarcode) lookupCode(initialBarcode);
  }, []);

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
    await uploadFiles(files, input);
  }

  /** Foto tirada na hora pelo celular: vem com 3–8 MB (passa do limite de
   *  5 MB do upload) — reduz pra 1600px de lado maior em JPEG antes de enviar. */
  async function onCameraPhoto(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      const photo = blob ? new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' }) : file;
      await uploadFiles([photo], input);
    } catch {
      await uploadFiles([file], input); // não deu pra reduzir: tenta o original
    }
  }

  async function uploadFiles(files: File[], input: HTMLInputElement) {
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
          price_cents: moneyToCents(form.price),
          compare_at_price_cents: form.compare_at
            ? moneyToCents(form.compare_at)
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
    if (!product) {
      const discard = await confirmDialog({
        title: 'Descartar este cadastro?',
        message: 'Nada foi salvo ainda.',
        confirmLabel: 'Descartar',
      });
      if (discard) window.location.href = '/admin/produtos';
      return;
    }
    const ok = await confirmDialog({
      title: 'Excluir produto?',
      message: `"${product.name}" sai do catálogo. Isso não pode ser desfeito.`,
    });
    if (!ok) return;
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
        {/* primeiro de tudo: bipar o código já busca e preenche o resto */}
        <div class="block sm:col-span-2">
          <label class="label" for="product-barcode">Código de barras</label>
          <div class="flex items-stretch gap-2">
            <input
              id="product-barcode"
              class="field min-w-0 flex-1"
              inputMode="numeric"
              placeholder="digitar código de barras manualmente"
              value={form.barcode}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = el.value.replace(/\D/g, '').slice(0, 14);
                el.value = v;
                upd('barcode', v);
              }}
              onKeyDown={(e) => {
                // o leitor "digita" o código e um Enter — não deixa isso enviar o
                // form sozinho; em vez disso, busca os dados do produto
                if (e.key === 'Enter') {
                  e.preventDefault();
                  lookupCode((e.target as HTMLInputElement).value);
                }
              }}
            />
            <CameraScanButton
              onCode={(code) => {
                upd('barcode', code);
                lookupCode(code);
              }}
            />
          </div>
          {lookup.state === 'busy' && <p class="mt-1.5 font-sans text-[12px] text-ink-muted">Buscando o produto pelo código…</p>}
          {lookup.state === 'error' && (
            <p class="mt-1.5 font-sans text-[12px] text-amber-700">Não consegui consultar as bases de produtos agora. Tente bipar de novo.</p>
          )}
          {lookup.state === 'none' && (
            <p class="mt-1.5 font-sans text-[12px] text-ink-muted">Produto não encontrado nas bases públicas — preencha manualmente.</p>
          )}
          {lookup.state === 'found' && (
            <div class="mt-1.5 rounded-card border border-agua/40 bg-agua/10 p-2.5 font-sans text-[12px] text-ink">
              <p>
                Encontrado: <strong>{lookup.data.name}</strong>
                {lookup.data.brand ? ` · ${lookup.data.brand}` : ''}.{' '}
                {lookup.filled.length ? `Preenchi: ${lookup.filled.join(', ')}. ` : 'Os campos já estão com os dados deste código. '}
                Confira antes de salvar.
              </p>
              {lookup.data.image && !images.includes(lookup.data.image) && (
                <div class="mt-2 flex items-center gap-2">
                  <img src={lookup.data.image} alt="" class="h-12 w-12 rounded border border-ink/10 object-cover" />
                  <button type="button" class="underline" onClick={() => setImages((l) => [...l, lookup.data.image!])}>
                    Usar esta foto
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
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
            <option value="" disabled>
              {tree.length === 0 ? '— crie categorias primeiro —' : 'Selecione a subcategoria'}
            </option>
            {tree.map((root) => (
              <optgroup label={root.name}>
                {root.children.length === 0 && <option disabled>(sem subcategorias)</option>}
                {root.children.map((sub) => <option value={sub.id}>{sub.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label class="block">
          <span class="label">Preço</span>
          <span class="relative block">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-sans text-sm text-ink-muted">R$</span>
            <input
              class="field pl-10"
              inputMode="numeric"
              placeholder="0,00"
              value={form.price}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = maskMoney(el.value);
                el.value = v;
                upd('price', v);
              }} required
            />
          </span>
        </label>
        <label class="block">
          <span class="label">Preço "de" / comparação</span>
          <span class="relative block">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-sans text-sm text-ink-muted">R$</span>
            <input
              class="field pl-10"
              inputMode="numeric"
              placeholder="0,00"
              value={form.compare_at}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = maskMoney(el.value);
                el.value = v;
                upd('compare_at', v);
              }}
            />
          </span>
        </label>
        <div class="block">
          <label class="label" for="product-stock">Estoque</label>
          <div class="flex items-stretch gap-2">
            <button
              type="button"
              class="w-12 shrink-0 rounded-card border border-ink/20 font-sans text-xl text-ink disabled:opacity-30"
              aria-label="Diminuir estoque"
              disabled={(parseInt(form.stock, 10) || 0) <= 0}
              onClick={() => upd('stock', String(Math.max(0, (parseInt(form.stock, 10) || 0) - 1)))}
            >
              −
            </button>
            <input
              id="product-stock"
              class="field text-center"
              inputMode="numeric"
              value={form.stock}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
                el.value = v;
                upd('stock', v);
              }}
              onBlur={() => !form.stock && upd('stock', '0')}
            />
            <button
              type="button"
              class="w-12 shrink-0 rounded-card border border-ink/20 font-sans text-xl text-ink"
              aria-label="Aumentar estoque"
              onClick={() => upd('stock', String((parseInt(form.stock, 10) || 0) + 1))}
            >
              +
            </button>
          </div>
        </div>
      </div>

      <label class="block">
        <span class="label">Marca</span>
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
            {uploading ? 'Enviando…' : 'Fazer upload'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple class="hidden" onChange={onFiles} disabled={uploading} />
          </label>
          {/* celular/tablet: abre a câmera direto pra fotografar o produto */}
          <label class="btn-outline hidden cursor-pointer text-[13px] [@media(pointer:coarse)]:inline-flex">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="mr-1.5" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
            Tirar foto
            <input type="file" accept="image/*" capture="environment" class="hidden" onChange={onCameraPhoto} disabled={uploading} />
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

      {/* botões do mesmo tamanho: colunas iguais */}
      <div class="grid grid-cols-3 gap-3 pt-2">
        <button type="submit" class="btn-primary w-full" disabled={saving}>
          {saving ? 'Salvando…' : product ? 'Salvar' : 'Criar produto'}
        </button>
        <a href="/admin/produtos" class="btn-outline w-full">Cancelar</a>
        {/* editando: apaga o produto; cadastro novo: descarta o que foi preenchido */}
        <button type="button" onClick={remove} class="btn-outline w-full" disabled={saving}>
          Excluir
        </button>
      </div>
    </form>
  );
}
