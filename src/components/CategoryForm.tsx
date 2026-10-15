import { useState } from 'preact/hooks';
import type { Category } from '../lib/types';
import { slugify } from '../lib/format';
import { askSaveActive } from '../lib/confirm-dialog';
import FormActions, { SavedNotice } from './FormActions';

interface Props {
  category: Category | null;
  /** nome do pai, quando editando uma subcategoria */
  parentName: string | null;
  /** raízes disponíveis para escolher como pai ao criar */
  roots: { id: string; name: string }[];
}

export default function CategoryForm({ category, parentName, roots }: Props) {
  const [form, setForm] = useState({
    name: category?.name ?? '',
    slug: category?.slug ?? '',
    description: category?.description ?? '',
    image_url: category?.image_url ?? '',
    parent_id: '',
    is_active: category?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // cadastro novo volta para a edição com ?salvo=1
  const [saved, setSaved] = useState(() => typeof location !== 'undefined' && new URLSearchParams(location.search).has('salvo'));

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('files', file);
      fd.append('folder', 'categorias');
      const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no upload.');
      upd('image_url', data.urls[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no upload.');
    } finally {
      setUploading(false);
      input.value = '';
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    const ok = await askSaveActive(form.is_active, {
      fem: true,
      on: 'A categoria aparece no menu e nos filtros da loja.',
      off: 'A categoria some do menu e dos filtros da loja (os produtos dela continuam à venda).',
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: category?.id,
          name: form.name,
          slug: form.slug || slugify(form.name),
          description: form.description,
          image_url: form.image_url,
          is_active: form.is_active,
          parent_id: category ? undefined : form.parent_id || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar.');
      // fica na edição (cadastro novo vai para a edição dele)
      if (!category) return void (window.location.href = data.id ? `/admin/categorias/${data.id}?salvo=1` : '/admin/categorias');
      setSaved(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!category) return;
    const res = await fetch(`/api/admin/categories?id=${category.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) window.location.href = '/admin/categorias';
    else setError(data.error || 'Erro ao excluir.');
  }

  return (
    <form onSubmit={submit} class="max-w-2xl space-y-5">
      {saved && <SavedNotice text="Categoria salva com sucesso!" />}
      {error && <p class="rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <p class="rounded-card border border-ink/10 bg-bone-50 px-3 py-2 text-[13px] text-ink-soft">
        {category
          ? parentName
            ? `Subcategoria de: ${parentName}. Para mudar a hierarquia, arraste na lista de categorias.`
            : 'Categoria raiz. Para transformá-la em subcategoria, arraste-a para dentro de outra na lista.'
          : 'A hierarquia é ajustada arrastando na lista. Aqui você define só os dados.'}
      </p>

      <label class="block">
        <span class="label">Nome</span>
        <input class="field" value={form.name} onInput={(e) => upd('name', (e.target as HTMLInputElement).value)} required />
      </label>

      {!category && (
        <label class="block">
          <span class="label">Criar como</span>
          <select class="field" value={form.parent_id} onChange={(e) => upd('parent_id', (e.target as HTMLSelectElement).value)}>
            <option value="">Categoria raiz (nível 1)</option>
            {roots.map((r) => <option value={r.id}>Subcategoria de {r.name}</option>)}
          </select>
        </label>
      )}

      <label class="block">
        <span class="label">Slug (URL) — /loja?categoria=<b>{form.slug || slugify(form.name)}</b></span>
        <input class="field" value={form.slug} placeholder="gerado do nome se vazio" onInput={(e) => upd('slug', (e.target as HTMLInputElement).value)} />
      </label>
      <label class="block">
        <span class="label">Descrição</span>
        <input class="field" value={form.description} onInput={(e) => upd('description', (e.target as HTMLInputElement).value)} />
      </label>

      <div>
        <span class="label">Imagem de fundo (vazio = 1ª imagem de um produto da categoria)</span>
        {form.image_url && (
          <div class="relative mb-2 overflow-hidden rounded-card border border-ink/10">
            <img src={form.image_url} alt="" class="aspect-[16/6] w-full object-cover" />
            <button type="button" class="absolute right-2 top-2 rounded bg-ink/70 px-2 py-1 text-[11px] text-bone" onClick={() => upd('image_url', '')}>Remover</button>
          </div>
        )}
        <div class="flex flex-wrap items-center gap-3">
          <label class="btn-outline cursor-pointer text-[13px]">
            {uploading ? 'Enviando…' : 'Enviar imagem'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" class="hidden" onChange={onFile} disabled={uploading} />
          </label>
          <input class="field flex-1 text-[13px]" placeholder="ou cole uma URL" value={form.image_url} onInput={(e) => upd('image_url', (e.target as HTMLInputElement).value)} />
        </div>
      </div>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.is_active} onChange={(e) => upd('is_active', (e.target as HTMLInputElement).checked)} />
        Ativa (aparece no menu e nos filtros da loja)
      </label>

      <FormActions
        listHref="/admin/categorias"
        saving={saving}
        isNew={!category}
        saveLabel={category ? 'Salvar' : 'Criar categoria'}
        deleteTitle="Excluir categoria?"
        deleteMessage={`"${category?.name ?? ''}" será excluída. Isso não pode ser desfeito.`}
        onDelete={remove}
      />
    </form>
  );
}
