import { useEffect, useRef, useState } from 'preact/hooks';
import CameraScanButton from './CameraScanButton';
import ImageStrip from './ImageStrip';
import { confirmDialog } from '../lib/confirm-dialog';
import { deleteProductFlow } from '../lib/delete-product';
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
/** Botões de adicionar imagem: ocupam a coluna inteira; padding menor que o
 *  .btn pra caber três por linha no celular. */
const IMG_BTN =
  'btn-outline h-12 w-full min-w-0 gap-1 whitespace-nowrap px-1.5 py-0 text-[11px] tracking-[0.02em] sm:gap-1.5 sm:px-2 sm:text-[13px] sm:tracking-[0.06em] [&>svg]:shrink-0';

/** Máximo de fotos por produto. */
const MAX_IMAGES = 5;

const moneyToCents = (masked: string) => Number(masked.replace(/\D/g, '') || '0');

/** Rótulo do campo: * vermelho quando obrigatório, "(opcional)" apagado quando não. */
function FieldLabel({ text, htmlFor, required }: { text: string; htmlFor: string; required?: boolean }) {
  return (
    <label class="label flex items-center gap-1.5" for={htmlFor}>
      {text}
      {required ? (
        <span class="text-red-600" aria-hidden="true">*</span>
      ) : (
        <span class="text-[11px] font-normal text-ink-muted/60">(opcional)</span>
      )}
    </label>
  );
}

/** Campos obrigatórios, na ordem da tela — o nome aparece na mensagem de erro. */
const REQUIRED = [
  ['barcode', 'código de barras'],
  ['name', 'nome'],
  ['short_description', 'marca'],
  ['category_id', 'subcategoria'],
  ['price', 'preço'],
  ['stock', 'estoque'],
  ['description', 'descrição completa'],
] as const;

export default function AdminProductForm({ product, tree, initialBarcode }: Props) {
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [urlInput, setUrlInput] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const full = images.length >= MAX_IMAGES;
  const [form, setForm] = useState({
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    // produto novo começa sem categoria — o admin escolhe (obrigatório no envio)
    category_id: product?.category_id ?? '',
    short_description: product?.short_description ?? '',
    description: product?.description ?? '',
    ingredients: product?.ingredients ?? '',
    how_to_use: product?.how_to_use ?? '',
    // preços guardados já mascarados ("1.234,56"); o R$ fica fixo na frente do campo.
    // Preço = valor cheio; oferta = valor com desconto. No banco, price_cents é o
    // que o cliente paga e compare_at_price_cents o "de" — com oferta, o preço
    // cheio mora no compare_at.
    price: product
      ? maskMoney(String(product.compare_at_price_cents ?? product.price_cents))
      : '',
    offer: product?.compare_at_price_cents ? maskMoney(String(product.price_cents)) : '',
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
  // foto que veio da base pública (pra trocar se o admin bipar outro produto)
  const autoImage = useRef<string | null>(null);

  // "Produto já cadastrado": chega com ?cadastrado=1 (o cadastro novo achou o
  // código na loja e abriu este). Fica 40s e some com fade.
  const [notice, setNotice] = useState<'off' | 'on' | 'fading'>('off');
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('cadastrado') !== '1') return;
    url.searchParams.delete('cadastrado');
    history.replaceState(null, '', url); // recarregar não mostra de novo
    setNotice('on');
    const fade = setTimeout(() => setNotice('fading'), 40_000);
    const hide = setTimeout(() => setNotice('off'), 40_500);
    return () => (clearTimeout(fade), clearTimeout(hide));
  }, []);

  // campos obrigatórios vazios na última tentativa de salvar (ficam em vermelho)
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    if (invalid.has(k)) setInvalid((cur) => new Set([...cur].filter((x) => x !== k)));
  }
  const bad = (k: string) => (invalid.has(k) ? ' border-red-500' : '');

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
          if (!p) return null;
          const name = (p.product_name_pt || p.product_name || '').trim();
          const brand = (p.brands || '').split(',')[0]?.trim() || null;
          const image = p.image_front_url || null;
          // marca e foto sem nome ainda valem (mesma regra do servidor)
          if (!name && !brand && !image) return null;
          const qty = (p.quantity || '').trim();
          const generic = (p.generic_name_pt || p.generic_name || '').trim();
          return {
            source: h.split('.')[1]!,
            name: name && qty && !name.includes(qty) ? `${name} ${qty}` : name,
            brand,
            description: generic && generic.toLowerCase() !== name.toLowerCase() ? generic : null,
            image,
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
      // cadastro novo: se o código já é de um produto da loja, abre o cadastro
      // dele pra editar (com o aviso "Produto já cadastrado")
      if (!product) {
        const own = await fetch(`/api/admin/products/by-barcode?code=${code}`).catch(() => null);
        if (own?.ok) {
          const { id } = (await own.json()) as { id: string };
          window.location.href = `/admin/produtos/${id}?cadastrado=1`;
          return;
        }
      }
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
      put('name', data.name, 'Nome');
      put('short_description', data.brand, 'Marca');
      put('description', data.description, 'Descrição');
      setForm((cur) => ({ ...cur, ...patch }));
      const prevImage = overwrite ? autoImage.current : null;
      const newImage = data.image;
      setImages((list) => {
        let next = prevImage ? list.filter((u) => u !== prevImage) : list;
        if (newImage && !next.includes(newImage) && next.length < MAX_IMAGES) next = [...next, newImage];
        return next;
      });
      if (newImage && !images.includes(newImage)) filled.push('Foto');
      autoImage.current = newImage;
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
    if (!url || images.includes(url)) return setUrlInput('');
    if (images.length >= MAX_IMAGES) return setError(`Máximo de ${MAX_IMAGES} imagens por produto.`);
    setImages((list) => [...list, url]);
    setUrlInput('');
    setShowUrl(false);
  }

  async function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    await uploadFiles(files, input);
  }

  async function onCameraPhoto(e: Event) {
    const input = e.target as HTMLInputElement;
    await uploadFiles(input.files?.[0] ? [input.files[0]] : [], input);
  }

  /** Foto de celular vem com 3–8 MB: reduz pra 1600px de lado maior em JPEG
   *  antes de enviar (passa do limite do upload e do corpo da requisição). */
  async function shrink(file: File): Promise<File> {
    if (file.size < 1024 * 1024) return file; // pequena: vai como está
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      return blob ? new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' }) : file;
    } catch {
      return file; // não deu pra reduzir: tenta o original
    }
  }

  /** Uma foto por requisição: várias juntas estouravam o limite do servidor
   *  ("Request Entity Too Large"). As que subirem ficam, mesmo se uma falhar. */
  async function uploadFiles(selected: File[], input: HTMLInputElement) {
    if (!selected.length) return;
    const room = MAX_IMAGES - images.length;
    const files = selected.slice(0, Math.max(0, room));
    setError(null);
    if (files.length < selected.length) {
      setError(
        room <= 0
          ? `Máximo de ${MAX_IMAGES} imagens por produto. Remova uma para adicionar outra.`
          : `Máximo de ${MAX_IMAGES} imagens: enviei só ${files.length} de ${selected.length}.`,
      );
    }
    if (!files.length) return void (input.value = '');
    setUploading(true);
    const failed: string[] = [];
    for (const original of files) {
      try {
        const fd = new FormData();
        fd.append('files', await shrink(original));
        const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => null); // erro do servidor pode vir em texto
        if (!res.ok || !data?.urls) {
          failed.push(data?.error || (res.status === 413 ? 'imagem grande demais' : `erro ${res.status}`));
          continue;
        }
        setImages((list) => [...list, ...data.urls.filter((u: string) => !list.includes(u))]);
      } catch {
        failed.push('falha de conexão');
      }
    }
    if (failed.length) {
      const n = failed.length;
      setError(`${n === files.length ? 'Nenhuma foto enviada' : `${n} de ${files.length} fotos não foram enviadas`}: ${[...new Set(failed)].join('; ')}.`);
    }
    setUploading(false);
    input.value = '';
  }

  async function submit(e: Event) {
    e.preventDefault();
    const missing = REQUIRED.filter(([k]) =>
      k === 'price' ? moneyToCents(form.price) <= 0 : !String(form[k]).trim(),
    );
    if (missing.length) {
      setInvalid(new Set(missing.map(([k]) => k)));
      setError(`Preencha: ${missing.map(([, label]) => label).join(', ')}.`);
      return window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    const priceCents = moneyToCents(form.price);
    const offerCents = form.offer ? moneyToCents(form.offer) : 0;
    if (offerCents && offerCents >= priceCents) {
      setInvalid(new Set(['offer']));
      setError('A oferta precisa ser menor que o preço.');
      return window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setInvalid(new Set());
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
          price_cents: offerCents || priceCents,
          compare_at_price_cents: offerCents ? priceCents : null,
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

  async function cancel() {
    const leave = await confirmDialog({
      title: 'Sair e perder alterações?',
      confirmLabel: 'Sair',
      cancelLabel: 'Manter alterações',
    });
    if (leave) window.location.href = '/admin/produtos';
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
    setSaving(true);
    const r = await deleteProductFlow(product.id, product.name);
    if (r === 'deleted' || r === 'deactivated') return void (window.location.href = '/admin/produtos');
    if (r !== 'cancelled') setError(r.error);
    setSaving(false);
  }

  return (
    <form onSubmit={submit} noValidate class="max-w-2xl space-y-5">
      {error && <p class="rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <div class="grid gap-4 sm:grid-cols-2">
        {/* primeiro de tudo: bipar o código já busca e preenche o resto */}
        <div class="sm:col-span-2">
          {notice !== 'off' && (
            <div
              role="status"
              class={`notice-in mb-2 inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 font-sans text-[12px] text-green-800 transition-opacity duration-500 ${notice === 'fading' ? 'opacity-0' : ''}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              Produto já cadastrado
            </div>
          )}
          <FieldLabel text="Código de barras" htmlFor="product-barcode" required />
          <div class="flex items-stretch gap-2">
            <input
              id="product-barcode"
              class={`field min-w-0 flex-1${bad('barcode')}`}
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
          </div>
          <div class="mt-2 flex justify-end">
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
            <p class="mt-1.5 font-sans text-[12px] text-ink-muted">Produto não encontrado - Preenchimento manual.</p>
          )}
          {lookup.state === 'found' && (
            <p class="mt-1.5 rounded-card border border-agua/40 bg-agua/10 p-2.5 font-sans text-[12px] text-ink">
              {lookup.filled.length
                ? `Campos preenchidos automaticamente: ${lookup.filled.join(', ')}. Confira antes de salvar.`
                : 'Os campos já estão com os dados deste código. Confira antes de salvar.'}
            </p>
          )}
        </div>
        <div class="sm:col-span-2">
          <FieldLabel text="Nome" htmlFor="product-name" required />
          <input id="product-name" class={`field${bad('name')}`} value={form.name} onInput={(e) => upd('name', (e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <FieldLabel text="Marca" htmlFor="product-brand" required />
          <input id="product-brand" class={`field${bad('short_description')}`} value={form.short_description} onInput={(e) => upd('short_description', (e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <FieldLabel text="Subcategoria" htmlFor="product-category" required />
          <select id="product-category" class={`field${bad('category_id')}`} value={form.category_id} onChange={(e) => upd('category_id', (e.target as HTMLSelectElement).value)}>
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
        </div>
        <div>
          <FieldLabel text="Preço" htmlFor="product-price" required />
          <span class="relative block">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-sans text-sm text-ink-muted">R$</span>
            <input
              id="product-price"
              class={`field pl-10${bad('price')}`}
              inputMode="numeric"
              placeholder="0,00"
              value={form.price}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = maskMoney(el.value);
                el.value = v;
                upd('price', v);
              }}
            />
          </span>
        </div>
        <div>
          <FieldLabel text="Oferta" htmlFor="product-offer" />
          <span class="relative block">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-sans text-sm text-ink-muted">R$</span>
            <input
              id="product-offer"
              class={`field pl-10${bad('offer')}`}
              inputMode="numeric"
              placeholder="0,00"
              value={form.offer}
              onInput={(e) => {
                const el = e.target as HTMLInputElement;
                const v = maskMoney(el.value);
                el.value = v;
                upd('offer', v);
              }}
            />
          </span>
        </div>
        <div>
          <FieldLabel text="Estoque" htmlFor="product-stock" required />
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
              class={`field text-center${bad('stock')}`}
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
        <div class="sm:col-span-2">
          <FieldLabel text="Descrição completa" htmlFor="product-description" required />
          <textarea id="product-description" class={`field${bad('description')}`} rows={4} value={form.description} onInput={(e) => upd('description', (e.target as HTMLTextAreaElement).value)} />
        </div>
        <div class="sm:col-span-2">
          <FieldLabel text="Material" htmlFor="product-material" />
          <textarea id="product-material" class="field" rows={3} value={form.ingredients} onInput={(e) => upd('ingredients', (e.target as HTMLTextAreaElement).value)} />
        </div>
        <div class="sm:col-span-2">
          <FieldLabel text="Cuidados" htmlFor="product-care" />
          <textarea id="product-care" class="field" rows={3} value={form.how_to_use} onInput={(e) => upd('how_to_use', (e.target as HTMLTextAreaElement).value)} />
        </div>
        <div class="sm:col-span-2">
          <FieldLabel text="Nome do link (URL)" htmlFor="product-slug" />
          <input id="product-slug" class="field" value={form.slug} onInput={(e) => upd('slug', (e.target as HTMLInputElement).value)} />
        </div>
      </div>

      <div>
        <span class="label">Imagens do produto</span>
        <p class="text-[12px] text-ink-muted">Adicione até cinco imagens utilizando um ou mais meios.</p>
        <ul class="mb-3 mt-1 text-[12px] text-ink-muted">
          <li>Formatos aceitos: JPG, PNG, WebP ou AVIF</li>
          <li>Limite de tamanho: 5 MB (cada imagem)</li>
        </ul>

        {/* Câmera (só em tela de toque), Selecionar e URL na mesma linha, colunas
            iguais; o campo do link aparece embaixo ao tocar em URL */}
        <div class="grid grid-cols-2 gap-2 [@media(pointer:coarse)]:grid-cols-3">
          <label class={`${IMG_BTN} hidden [@media(pointer:coarse)]:inline-flex ${full ? 'pointer-events-none opacity-40' : 'cursor-pointer'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
            Abrir Câmera
            <input type="file" accept="image/*" capture="environment" class="hidden" onChange={onCameraPhoto} disabled={uploading || full} />
          </label>
          <label class={`${IMG_BTN} ${full ? 'pointer-events-none opacity-40' : 'cursor-pointer'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v4h14v-4" /></svg>
            {uploading ? 'Enviando…' : 'Selecionar'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple class="hidden" onChange={onFiles} disabled={uploading || full} />
          </label>
          <button
            type="button"
            class={`${IMG_BTN} disabled:pointer-events-none disabled:opacity-40 ${showUrl ? 'border-ink bg-bone-200' : ''}`}
            onClick={() => setShowUrl((v) => !v)}
            disabled={full}
            aria-expanded={showUrl}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></svg>
            URL
          </button>
          {showUrl && !full && (
            <>
              <input
                class="field h-12 min-w-0 py-0 text-[13px] [@media(pointer:coarse)]:col-span-2"
                placeholder="cole o link da imagem"
                aria-label="Link da imagem"
                value={urlInput}
                autoFocus
                onInput={(e) => setUrlInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } }}
              />
              <button type="button" class={IMG_BTN} onClick={addUrl} aria-label="Adicionar imagem pelo link">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </button>
            </>
          )}
        </div>

        <ImageStrip images={images} onChange={setImages} />
        {images.length > 1 && (
          <p class="text-[12px] text-ink-muted">A primeira é a capa. Arraste para o lado para mudar a ordem.</p>
        )}
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
        <button type="button" onClick={cancel} class="btn-outline w-full">Cancelar</button>
        {/* editando: apaga o produto; cadastro novo: descarta o que foi preenchido */}
        <button type="button" onClick={remove} class="btn-outline w-full" disabled={saving}>
          Excluir
        </button>
      </div>
    </form>
  );
}
