import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { SiteSectionKey } from '../lib/types';
import { askSaveActive, confirmDialog } from '../lib/confirm-dialog';
import FormActions, { SavedNotice } from './FormActions';

interface Props {
  section: SiteSectionKey;
  entry: { is_active: boolean; data: unknown };
}

const TOGGLEABLE: SiteSectionKey[] = ['home_bestsellers', 'home_story', 'home_social'];

export default function SiteSectionForm({ section, entry }: Props) {
  const [isActive, setIsActive] = useState<boolean>(entry.is_active);
  const [data, setData] = useState<Record<string, unknown>>({ ...(entry.data as Record<string, unknown>) });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set(key: string, value: unknown) {
    setData((d) => ({ ...d, [key]: value }));
  }
  const s = (key: string) => (data[key] as string) ?? '';

  async function onLogoFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setNotice(null);

    const problem = await validateLogo(file);
    if (problem) {
      setError(problem);
      return;
    }
    const dims = await readImageSize(file);
    if (dims && dims.w < 400) {
      setNotice(`Logo com ${dims.w}px de largura — pode ficar levemente serrilhado em telas retina. O ideal é ≥ 400px.`);
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('files', file);
      fd.append('folder', 'site');
      fd.append('kind', 'logo');
      const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Falha no upload.');
      set('logo_url', out.urls[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no upload.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    // só as seções da home ligam/desligam; as outras estão sempre no site
    if (TOGGLEABLE.includes(section)) {
      const ok = await askSaveActive(isActive, { fem: true, on: 'A seção aparece na home.', off: 'A seção some da home.' });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/site', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section, is_active: isActive, data }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Erro ao salvar.');
      // fica na edição, como em Produtos
      setSaved(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function restore() {
    const ok = await confirmDialog({
      title: 'Restaurar o texto padrão?',
      message: 'As edições atuais desta seção serão perdidas.',
      confirmLabel: 'Restaurar',
    });
    if (!ok) return;
    const res = await fetch('/api/admin/site?action=reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section }),
    });
    if (res.ok) window.location.reload();
    else setError('Não foi possível restaurar.');
  }

  return (
    <form onSubmit={submit} class="max-w-2xl space-y-5">
      {saved && <SavedNotice text="Seção salva com sucesso!" />}
      {error && <p class="rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {notice && <p class="rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}

      {section === 'brand' && (
        <div>
          <span class="label">Logotipo do cabeçalho</span>
          {s('logo_url') ? (
            <div class="mb-3 flex items-center gap-4 rounded-card border border-ink/10 bg-bone-50 p-4">
              <img src={s('logo_url')} alt="Logo" class="h-9 w-auto max-w-[200px] object-contain" />
              <button type="button" class="text-sm text-red-700 hover:underline" onClick={() => set('logo_url', '')}>
                Remover
              </button>
            </div>
          ) : (
            <p class="mb-3 text-[13px] text-ink-muted">
              Sem logo enviado — o site mostra o nome da marca em texto (padrão).
            </p>
          )}
          <label class="btn-outline cursor-pointer text-[13px]">
            {uploading ? 'Enviando…' : s('logo_url') ? 'Trocar logo' : 'Enviar logo'}
            <input type="file" accept="image/png,image/webp" class="hidden" onChange={onLogoFile} disabled={uploading} />
          </label>
          <ul class="mt-3 list-disc space-y-1 pl-5 text-[12px] text-ink-muted">
            <li>PNG ou WebP com fundo transparente (nada de JPG)</li>
            <li>Entre 200×60 px e 2000×1000 px, proporção de 1:1 a 8:1</li>
            <li>Até 1 MB — de preferência ≥ 400 px de largura</li>
            <li>Aparece com ~28 px de altura no topo; o rodapé continua em texto</li>
          </ul>
        </div>
      )}

      {TOGGLEABLE.includes(section) && (
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive((e.target as HTMLInputElement).checked)} />
          Ativa (aparece na home)
        </label>
      )}

      {section === 'home_bestsellers' && (
        <>
          <Text label="Chapéu / eyebrow" value={s('eyebrow')} onInput={(v) => set('eyebrow', v)} />
          <Text label="Título" value={s('title')} onInput={(v) => set('title', v)} />
          <Row>
            <Text label="Texto do botão" value={s('cta_label')} onInput={(v) => set('cta_label', v)} />
            <Text label="Link do botão" value={s('cta_href')} onInput={(v) => set('cta_href', v)} placeholder="/loja" />
          </Row>
        </>
      )}

      {section === 'home_story' && (
        <>
          <Text label="Chapéu / eyebrow" value={s('eyebrow')} onInput={(v) => set('eyebrow', v)} />
          <Area label="Título (Enter quebra a linha)" value={s('title')} onInput={(v) => set('title', v)} />
          <Area label="Texto" value={s('body')} onInput={(v) => set('body', v)} />
          <Row>
            <Text label="Texto do botão" value={s('cta_label')} onInput={(v) => set('cta_label', v)} />
            <Text label="Link do botão" value={s('cta_href')} onInput={(v) => set('cta_href', v)} placeholder="/sobre" />
          </Row>
          <ListField
            label="Selos / diferenciais"
            items={(data.features as { title: string; body: string }[]) ?? []}
            onChange={(items) => set('features', items)}
            empty={{ title: '', body: '' }}
            render={(val, onInput) => (
              <div class="grid gap-2">
                <input class="field" placeholder="Título" value={val.title} onInput={(e) => onInput({ ...val, title: (e.target as HTMLInputElement).value })} />
                <input class="field" placeholder="Descrição" value={val.body} onInput={(e) => onInput({ ...val, body: (e.target as HTMLInputElement).value })} />
              </div>
            )}
          />
        </>
      )}

      {section === 'home_social' && (
        <>
          <Text label="Chapéu / eyebrow" value={s('eyebrow')} onInput={(v) => set('eyebrow', v)} />
          <Text label="Título" value={s('title')} onInput={(v) => set('title', v)} />
          <Text label="Subtítulo" value={s('subtitle')} onInput={(v) => set('subtitle', v)} />
          <ListField
            label="Depoimentos"
            items={(data.testimonials as { quote: string; name: string; detail: string }[]) ?? []}
            onChange={(items) => set('testimonials', items)}
            empty={{ quote: '', name: '', detail: '' }}
            render={(val, onInput) => (
              <div class="grid gap-2">
                <textarea class="field" rows={2} placeholder="Depoimento" value={val.quote} onInput={(e) => onInput({ ...val, quote: (e.target as HTMLTextAreaElement).value })} />
                <Row>
                  <input class="field" placeholder="Nome" value={val.name} onInput={(e) => onInput({ ...val, name: (e.target as HTMLInputElement).value })} />
                  <input class="field" placeholder="Detalhe (cidade, perfil…)" value={val.detail} onInput={(e) => onInput({ ...val, detail: (e.target as HTMLInputElement).value })} />
                </Row>
              </div>
            )}
          />
        </>
      )}

      {section === 'footer' && (
        <>
          <Area label="Frase da marca" value={s('tagline')} onInput={(v) => set('tagline', v)} />
          <Text label="Linha de trocas" value={s('returns_line')} onInput={(v) => set('returns_line', v)} />
          <Text label="Linha jurídica (o ano é adicionado automaticamente antes)" value={s('legal_line')} onInput={(v) => set('legal_line', v)} />
          <Text label="Linha de pagamento" value={s('payment_line')} onInput={(v) => set('payment_line', v)} />
        </>
      )}

      {section === 'contact' && (
        <>
          <Text label="E-mail de atendimento" value={s('email')} onInput={(v) => set('email', v)} placeholder="ola@suamarca.com.br" />
          <Text
            label="WhatsApp (só números, com DDI — ex.: 5511999998888)"
            value={s('whatsapp_number')}
            onInput={(v) => set('whatsapp_number', v)}
            placeholder="deixe vazio para usar o número do .env"
          />
          <Text label="Horário de atendimento" value={s('hours')} onInput={(v) => set('hours', v)} />
        </>
      )}

      {section === 'page_sobre' && (
        <>
          <Text label="Chapéu / eyebrow" value={s('hero_eyebrow')} onInput={(v) => set('hero_eyebrow', v)} />
          <Area label="Título (use Enter para quebrar a linha)" value={s('hero_title')} onInput={(v) => set('hero_title', v)} />

          <ListField
            label="Parágrafos da história"
            items={(data.paragraphs as string[]) ?? []}
            onChange={(items) => set('paragraphs', items)}
            empty=""
            render={(val, onInput) => (
              <textarea class="field" rows={3} value={val} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} />
            )}
          />

          <ListField
            label="Cards de valores"
            items={(data.values as { title: string; body: string }[]) ?? []}
            onChange={(items) => set('values', items)}
            empty={{ title: '', body: '' }}
            render={(val, onInput) => (
              <div class="grid gap-2">
                <input class="field" placeholder="Título" value={val.title} onInput={(e) => onInput({ ...val, title: (e.target as HTMLInputElement).value })} />
                <textarea class="field" rows={2} placeholder="Descrição" value={val.body} onInput={(e) => onInput({ ...val, body: (e.target as HTMLTextAreaElement).value })} />
              </div>
            )}
          />

          <Row>
            <Text label="Título da chamada final" value={s('cta_title')} onInput={(v) => set('cta_title', v)} />
            <Text label="Texto da chamada final" value={s('cta_body')} onInput={(v) => set('cta_body', v)} />
          </Row>
          <Row>
            <Text label="Texto do botão" value={s('cta_label')} onInput={(v) => set('cta_label', v)} />
            <Text label="Link do botão" value={s('cta_href')} onInput={(v) => set('cta_href', v)} placeholder="/loja?categoria=kits" />
          </Row>
        </>
      )}

      {section === 'page_contato' && (
        <>
          <Text label="Chapéu / eyebrow" value={s('eyebrow')} onInput={(v) => set('eyebrow', v)} />
          <Text label="Título" value={s('title')} onInput={(v) => set('title', v)} />
          <Area label="Texto de introdução" value={s('intro')} onInput={(v) => set('intro', v)} />
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={(data.show_form as boolean) !== false}
              onChange={(e) => set('show_form', (e.target as HTMLInputElement).checked)}
            />
            Mostrar o formulário de contato
          </label>
        </>
      )}

      <FormActions
        listHref="/admin/site"
        saving={saving}
        isNew={false}
        deleteTitle="Excluir seção?"
        deleteBlock="As seções do site são fixas e não podem ser excluídas. Para voltar ao texto original, use “Restaurar texto padrão”."
      />
      <button type="button" onClick={restore} class="text-sm text-red-700 hover:underline">
        Restaurar texto padrão
      </button>
    </form>
  );
}

// --- validação do logotipo ----------------------------------------------

function readImageSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

async function validateLogo(file: File): Promise<string | null> {
  if (!['image/png', 'image/webp'].includes(file.type)) {
    return 'Use PNG ou WebP (com fundo transparente). JPG deixa uma moldura branca em volta do logo.';
  }
  if (file.size > 1024 * 1024) {
    return `Arquivo de ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é 1 MB. Otimize o logo antes de enviar.`;
  }
  const dims = await readImageSize(file);
  if (!dims) return 'Não foi possível ler a imagem.';
  const { w, h } = dims;
  if (w < 200 || h < 60) return `Resolução baixa (${w}×${h}px). Envie pelo menos 200×60px.`;
  if (w > 2000 || h > 1000) return `Imagem grande demais (${w}×${h}px). Máximo 2000×1000px.`;
  const ratio = w / h;
  if (ratio < 1 || ratio > 8) {
    return `Proporção fora do ideal (${ratio.toFixed(1)}:1). Um logo de cabeçalho deve ficar entre 1:1 e 8:1.`;
  }
  return null;
}

// --- campos reutilizáveis -------------------------------------------------

function Row({ children }: { children: ComponentChildren }) {
  return <div class="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Text({
  label,
  value,
  onInput,
  placeholder,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label class="block">
      <span class="label">{label}</span>
      <input class="field" value={value} placeholder={placeholder} onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
    </label>
  );
}

function Area({ label, value, onInput }: { label: string; value: string; onInput: (v: string) => void }) {
  return (
    <label class="block">
      <span class="label">{label}</span>
      <textarea class="field" rows={3} value={value} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} />
    </label>
  );
}

function ListField<T>({
  label,
  items,
  onChange,
  empty,
  render,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  empty: T;
  render: (value: T, onInput: (v: T) => void) => ComponentChildren;
}) {
  const clone = (): T[] => items.map((i) => (typeof i === 'object' && i ? ({ ...i } as T) : i));
  return (
    <div>
      <span class="label">{label}</span>
      <ul class="space-y-3">
        {items.map((item, i) => (
          <li class="flex items-start gap-2 rounded-card border border-ink/10 bg-bone-50 p-3">
            <div class="min-w-0 flex-1">
              {render(item, (v) => {
                const next = clone();
                next[i] = v;
                onChange(next);
              })}
            </div>
            <div class="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                class="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-bone-200 hover:text-ink disabled:opacity-25"
                disabled={i === 0}
                onClick={() => {
                  const next = clone();
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
                aria-label="Subir"
              >
                ↑
              </button>
              <button
                type="button"
                class="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-bone-200 hover:text-ink disabled:opacity-25"
                disabled={i === items.length - 1}
                onClick={() => {
                  const next = clone();
                  [next[i + 1], next[i]] = [next[i], next[i + 1]];
                  onChange(next);
                }}
                aria-label="Descer"
              >
                ↓
              </button>
              <button
                type="button"
                class="grid h-7 w-7 place-items-center rounded text-red-700 hover:bg-red-50"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                aria-label="Remover"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        class="btn-outline mt-2 text-[13px]"
        onClick={() => onChange([...items, (typeof empty === 'object' && empty ? { ...empty } : empty) as T])}
      >
        Adicionar
      </button>
    </div>
  );
}
