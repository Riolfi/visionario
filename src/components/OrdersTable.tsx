import { useMemo, useRef, useState } from 'preact/hooks';
import { brl, orderLabel } from '../lib/format';

/**
 * Lista de Compras do admin: busca pelo código, filtro por coluna (pop-up
 * "Filtro": Formato e Status em multi-seleção, Data com "até" opcional),
 * filtros aplicados viram etiquetas removíveis ao lado do botão, e o rodapé
 * fixo soma o que está na tela. Tudo no navegador (a página traz as compras).
 */
export interface OrderRow {
  number: string;
  created_at: string;
  source: 'web' | 'caixa';
  status: string;
  status_label: string;
  total_cents: number;
}

const FORMATS = [
  ['web', 'Online'],
  ['caixa', 'Física'],
] as const;
const STATUSES = [
  ['pending', 'Aguardando pagamento'],
  ['paid', 'Pago / Concluída'],
  ['shipped', 'Enviado'],
  ['delivered', 'Entregue'],
  ['failed', 'Pagamento não concluído'],
  ['cancelled', 'Cancelado'],
] as const;

interface Filters {
  formats: string[];
  statuses: string[];
  from: string; // AAAA-MM-DD
  to: string;
}
const EMPTY: Filters = { formats: [], statuses: [], from: '', to: '' };

/** dia local (AAAA-MM-DD) da compra — comparação de data sem fuso */
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const br = (day: string) => day.split('-').reverse().join('/');
const labelOf = (list: readonly (readonly [string, string])[], key: string) => list.find(([k]) => k === key)?.[1] ?? key;

const FILTER_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" /></svg>
);
const X_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

export default function OrdersTable({ orders }: { orders: OrderRow[] }) {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [open, setOpen] = useState<string | null>(null); // seção aberta no pop-up
  const dialog = useRef<HTMLDialogElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '');
    return orders.filter((o) => {
      if (q && !o.number.toLowerCase().includes(q)) return false;
      if (applied.formats.length && !applied.formats.includes(o.source)) return false;
      if (applied.statuses.length && !applied.statuses.includes(o.status)) return false;
      const day = localDay(o.created_at);
      if (applied.from && !applied.to && day !== applied.from) return false; // só "Data": o dia
      if (applied.from && applied.to && (day < applied.from || day > applied.to)) return false;
      if (!applied.from && applied.to && day > applied.to) return false; // só "até": tudo até o dia
      return true;
    });
  }, [orders, query, applied]);
  const total = visible.reduce((s, o) => s + o.total_cents, 0);

  function openFilter() {
    setDraft(applied);
    setOpen(null);
    dialog.current?.showModal();
  }
  const close = () => dialog.current?.close();
  function apply() {
    // datas invertidas: troca
    const f = draft.from && draft.to && draft.to < draft.from ? { ...draft, from: draft.to, to: draft.from } : draft;
    setApplied(f);
    close();
  }
  const toggle = (key: 'formats' | 'statuses', value: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].includes(value) ? d[key].filter((v) => v !== value) : [...d[key], value] }));
  const remove = (key: 'formats' | 'statuses', value: string) =>
    setApplied((a) => ({ ...a, [key]: a[key].filter((v) => v !== value) }));

  const summary = (key: 'formats' | 'statuses', list: readonly (readonly [string, string])[]) =>
    draft[key].length ? draft[key].map((v) => labelOf(list, v)).join(', ') : 'Todos';

  // etiqueta de uma coluna: várias opções na mesma borda, separadas por |
  const Chip = ({ title, items }: { title: string; items: { label: string; onRemove: () => void }[] }) => (
    <span class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-ink bg-ink py-1 pl-3 pr-1.5 font-sans text-[13px] text-bone">
      <span class="text-bone/70">{title}:</span>
      {items.map((it, i) => (
        <>
          {i > 0 && <span class="text-bone/50" aria-hidden="true">|</span>}
          <span class="inline-flex items-center gap-1">
            {it.label}
            <button type="button" onClick={it.onRemove} class="grid h-5 w-5 place-items-center rounded-full hover:bg-bone/20" aria-label={`Tirar filtro ${title}: ${it.label}`}>
              {X_ICON}
            </button>
          </span>
        </>
      ))}
    </span>
  );

  const Section = ({ id, title, value, children }: { id: string; title: string; value: string; children: preact.ComponentChildren }) => (
    <div class="rounded-[18px] bg-white">
      <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-4 text-left" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
        <span class="font-sans text-[16px] font-medium text-ink">{title}</span>
        <span class="flex min-w-0 items-center gap-2 font-sans text-[14px] text-ink-muted">
          <span class="truncate">{value}</span>
          <svg class={`shrink-0 transition-transform ${open === id ? 'rotate-90' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </span>
      </button>
      {open === id && <div class="border-t border-ink/10 px-4 py-3">{children}</div>}
    </div>
  );

  const Options = ({ fkey, list }: { fkey: 'formats' | 'statuses'; list: readonly (readonly [string, string])[] }) => (
    <div class="space-y-1">
      {list.map(([value, label]) => (
        <label class="flex cursor-pointer items-center gap-3 rounded-card px-1 py-2 text-[15px] hover:bg-bone-50">
          <input type="checkbox" class="h-4 w-4" checked={draft[fkey].includes(value)} onChange={() => toggle(fkey, value)} />
          {label}
        </label>
      ))}
    </div>
  );

  const chips = [
    applied.formats.length > 0 && (
      <Chip key="f" title="Formato" items={applied.formats.map((v) => ({ label: labelOf(FORMATS, v), onRemove: () => remove('formats', v) }))} />
    ),
    applied.statuses.length > 0 && (
      <Chip key="s" title="Status" items={applied.statuses.map((v) => ({ label: labelOf(STATUSES, v), onRemove: () => remove('statuses', v) }))} />
    ),
    (applied.from || applied.to) && (
      <Chip
        key="d"
        title="Data"
        items={[
          {
            label: applied.from && applied.to ? `${br(applied.from)} a ${br(applied.to)}` : applied.from ? br(applied.from) : `até ${br(applied.to)}`,
            onRemove: () => setApplied((a) => ({ ...a, from: '', to: '' })),
          },
        ]}
      />
    ),
  ].filter(Boolean);

  return (
    <>
      {/* botão de filtro + filtros aplicados (rola pro lado no celular, sem barra) */}
      <div class="flex items-center gap-2">
        <button
          type="button"
          onClick={openFilter}
          class={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full border ${chips.length ? 'border-ink bg-ink text-bone' : 'border-ink/20 text-ink hover:border-ink'}`}
          aria-label="Filtro"
          title="Filtro"
        >
          {FILTER_ICON}
        </button>
        <div class="flex min-w-0 flex-1 gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.length ? chips : <span class="self-center font-sans text-[13px] text-ink-muted">Todas as compras</span>}
        </div>
      </div>

      <div class="mt-4 rounded-card border border-ink/10 bg-white p-4">
        <label class="label" for="order-search">Compra</label>
        <span class="relative block">
          <svg class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            id="order-search"
            class="field pl-11"
            type="search"
            inputMode="numeric"
            placeholder="Pesquise pelo código da compra…"
            autoComplete="off"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </span>
      </div>

      <div class="mt-4 rounded-card border border-ink/10 bg-white">
        <table class="w-full table-fixed text-left text-sm">
          <thead class="border-b border-ink/10 text-[10px] uppercase tracking-[0.04em] text-ink-muted sm:text-[11px] sm:tracking-[0.1em]">
            <tr>
              <th class="px-2 py-3 sm:px-3">Compra</th>
              <th class="hidden w-28 px-3 py-3 sm:table-cell">Data</th>
              <th class="w-14 px-1 py-3 sm:w-24 sm:px-3">Formato</th>
              <th class="w-[5.5rem] px-1 py-3 sm:w-44 sm:px-3">Status</th>
              <th class="w-[5rem] px-2 py-3 text-right sm:w-28 sm:px-3">Valor</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => {
              const date = new Date(o.created_at).toLocaleDateString('pt-BR');
              return (
                <tr key={o.number} class="border-t border-ink/10 hover:bg-bone-50">
                  <td class="px-2 py-3 sm:px-3">
                    <a href={`/admin/pedidos/${o.number}`} class="block truncate text-agua-dark">{orderLabel(o.number)}</a>
                    <span class="block text-[12px] text-ink-muted sm:hidden">{date}</span>
                  </td>
                  <td class="hidden px-3 py-3 text-ink-muted sm:table-cell">{date}</td>
                  <td class="px-1 py-3 text-[13px] text-ink-soft sm:px-3 sm:text-sm">{o.source === 'caixa' ? 'Física' : 'Online'}</td>
                  <td class="px-1 py-3 sm:px-3"><span class="inline-block rounded-full bg-bone-200 px-2 py-0.5 text-[10px] uppercase leading-tight sm:text-[11px]">{o.status_label}</span></td>
                  <td class="px-2 py-3 text-right text-[13px] sm:px-3 sm:text-sm">{brl(o.total_cents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && <p class="p-6 text-center text-sm text-ink-muted">Nenhuma compra encontrada.</p>}
      </div>

      {/* rodapé fixo: acompanha busca e filtros */}
      <div class="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center justify-between gap-4 border-t border-ink/10 bg-bone px-4 py-3 font-sans text-sm sm:-mx-6 sm:px-6">
        <span>Compras: <strong>{visible.length}</strong></span>
        <span>Total: <strong>{brl(total)}</strong></span>
      </div>

      {/* pop-up "Filtro": folha de baixo no celular, centralizado no desktop */}
      <dialog
        ref={dialog}
        class="filter-sheet m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-[28px] bg-[#f2f1f6] p-0 backdrop:bg-ink/50 sm:m-auto sm:max-w-md sm:rounded-[28px]"
        onClick={(e) => e.target === dialog.current && close()}
        aria-label="Filtro"
      >
        <div class="flex max-h-[92dvh] flex-col">
          <div class="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-ink/15 sm:hidden" aria-hidden="true" />
          <div class="relative px-5 pb-3 pt-4 text-center">
            <h2 class="font-sans text-[20px] font-bold text-ink">Filtro</h2>
            <button type="button" onClick={close} class="absolute right-4 top-3.5 grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="Fechar">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
            <Section id="formato" title="Formato" value={summary('formats', FORMATS)}>
              <Options fkey="formats" list={FORMATS} />
            </Section>
            <Section id="status" title="Status" value={summary('statuses', STATUSES)}>
              <Options fkey="statuses" list={STATUSES} />
            </Section>
            <div class="rounded-[18px] bg-white px-4 py-4">
              <p class="font-sans text-[16px] font-medium text-ink">Data</p>
              <div class="mt-3 grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="label">Data</span>
                  <input type="date" class="field py-2.5" value={draft.from} onInput={(e) => setDraft((d) => ({ ...d, from: (e.target as HTMLInputElement).value }))} />
                </label>
                <label class="block">
                  <span class="label">Data (até) <span class="text-[11px] font-normal text-ink-muted/60">(opcional)</span></span>
                  <input type="date" class="field py-2.5" value={draft.to} min={draft.from || undefined} onInput={(e) => setDraft((d) => ({ ...d, to: (e.target as HTMLInputElement).value }))} />
                </label>
              </div>
              <p class="mt-2 text-[12px] text-ink-muted">Sem "Data (até)", mostra só as compras do dia escolhido.</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 border-t border-ink/10 bg-[#f2f1f6] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
            <button type="button" onClick={() => setDraft(EMPTY)} class="rounded-full border border-ink/15 bg-white py-3.5 font-sans text-[16px] text-ink hover:border-ink">
              Limpar
            </button>
            <button type="button" onClick={apply} class="rounded-full bg-ink py-3.5 font-sans text-[16px] font-semibold text-bone">
              Filtrar
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
