import { useState } from 'preact/hooks';
import type { Offer } from '../lib/types';
import { askSaveActive } from '../lib/confirm-dialog';
import FormActions, { SavedNotice } from './FormActions';

export default function OfferForm({ offer }: { offer: Offer | null }) {
  const [form, setForm] = useState({
    image_url: offer?.image_url ?? '',
    eyebrow: offer?.eyebrow ?? '',
    title: offer?.title ?? '',
    subtitle: offer?.subtitle ?? '',
    cta_label: offer?.cta_label ?? '',
    cta_href: offer?.cta_href ?? '',
    is_active: offer?.is_active ?? true,
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
      fd.append('folder', 'offers');
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
      on: 'A oferta vai aparecer no carrossel da home.',
      off: 'A oferta não vai aparecer no carrossel da home.',
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/offers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: offer?.id, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar.');
      // fica na edição (cadastro novo vai para a edição dele)
      if (!offer) return void (window.location.href = data.id ? `/admin/ofertas/${data.id}?salvo=1` : '/admin/ofertas');
      setSaved(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!offer) return;
    const res = await fetch(`/api/admin/offers?id=${offer.id}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/admin/ofertas';
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Erro ao excluir.');
  }

  return (
    <form onSubmit={submit} class="max-w-2xl space-y-5">
      {saved && <SavedNotice text="Oferta salva com sucesso!" />}
      {error && <p class="rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <div>
        <span class="label">Imagem (tela cheia — use fotos horizontais grandes)</span>
        {form.image_url ? (
          <div class="relative mb-2 overflow-hidden rounded-card border border-ink/10">
            <img src={form.image_url} alt="" class="aspect-[16/7] w-full object-cover" />
            <button
              type="button"
              class="absolute right-2 top-2 rounded bg-ink/70 px-2 py-1 text-[11px] text-bone"
              onClick={() => upd('image_url', '')}
            >
              Remover
            </button>
          </div>
        ) : null}
        <div class="flex flex-wrap items-center gap-3">
          <label class="btn-outline cursor-pointer text-[13px]">
            {uploading ? 'Enviando…' : form.image_url ? 'Trocar imagem' : 'Enviar imagem'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" class="hidden" onChange={onFile} disabled={uploading} />
          </label>
          <input
            class="field flex-1 text-[13px]"
            placeholder="ou cole uma URL de imagem"
            value={form.image_url}
            onInput={(e) => upd('image_url', (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <label class="block">
        <span class="label">Chapéu / eyebrow (opcional)</span>
        <input class="field" value={form.eyebrow} onInput={(e) => upd('eyebrow', (e.target as HTMLInputElement).value)} placeholder="ex.: Coleção de verão" />
      </label>
      <label class="block">
        <span class="label">Título</span>
        <input class="field" value={form.title} onInput={(e) => upd('title', (e.target as HTMLInputElement).value)} required />
      </label>
      <label class="block">
        <span class="label">Subtítulo (opcional)</span>
        <textarea class="field" rows={2} value={form.subtitle} onInput={(e) => upd('subtitle', (e.target as HTMLTextAreaElement).value)} />
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="label">Texto do botão</span>
          <input class="field" value={form.cta_label} onInput={(e) => upd('cta_label', (e.target as HTMLInputElement).value)} placeholder="ex.: Ver ofertas" />
        </label>
        <label class="block">
          <span class="label">Link do botão</span>
          <input class="field" value={form.cta_href} onInput={(e) => upd('cta_href', (e.target as HTMLInputElement).value)} placeholder="/loja?ordenar=preco-asc" />
        </label>
      </div>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.is_active} onChange={(e) => upd('is_active', (e.target as HTMLInputElement).checked)} />
        Ativa (aparece no carrossel da home)
      </label>

      <FormActions
        listHref="/admin/ofertas"
        saving={saving}
        isNew={!offer}
        saveLabel={offer ? 'Salvar' : 'Criar oferta'}
        deleteTitle="Excluir oferta?"
        deleteMessage={`"${offer?.title || 'Esta oferta'}" sai do carrossel. Isso não pode ser desfeito.`}
        onDelete={remove}
      />
    </form>
  );
}
