import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { brl, orderLabel, orderStatusBadge } from '../lib/format';

/**
 * Lista de Compras do admin: busca pelo código, filtro por coluna (pop-up
 * "Filtro": Formato e Status em multi-seleção, Data com "até" opcional),
 * filtros aplicados viram etiquetas removíveis ao lado do botão, e o rodapé
 * (linha de totais no fim da tabela, presa no fim da tela) soma o que está na tela. Tudo no navegador (a página traz as compras).
 */
export interface OrderRow {
  number: string;
  created_at: string;
  source: 'web' | 'caixa';
  status: string;
  status_label: string;
  total_cents: number;
  customer: string;
  /** pedido de cancelamento do cliente esperando análise */
  cancel_pending?: boolean;
}

const FORMATS = [
  ['web', 'Online'],
  ['caixa', 'Física'],
] as const;
const STATUSES = [
  ['pending', 'Aguardando pagamento'],
  ['paid', 'Pago / Concluída'],
  ['separating', 'Em separação'],
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

/** Colunas proporcionais; abaixo da largura mínima a tabela rola pro lado. */
// última coluna: botão Editar (e a margem à direita do total no rodapé)
const COLS = 'grid grid-cols-[1.1fr_1.2fr_1.4fr_0.8fr_1.6fr_1fr_5.5rem] min-w-[50rem]';

// ordenação por coluna (clique no título alterna ▲/▼) e paginação (como lib/data-table)
type SortKey = 'number' | 'created_at' | 'customer' | 'status_label' | 'total_cents';
const SIZES = [10, 20, 30, 50];
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const PAGE_BTN = 'grid h-8 w-8 place-items-center rounded-card border border-ink/15 text-ink hover:bg-bone-100 disabled:cursor-not-allowed disabled:opacity-30';

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
  const box = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);

  // a tabela ocupa até o fim da tela: cabeçalho em cima, totais embaixo e as
  // compras rolando entre eles (sobra espaço em branco quando são poucas)
  useEffect(() => {
    const fit = () => {
      const el = box.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const pad = parseFloat(getComputedStyle(el.closest('main') ?? document.body).paddingBottom) || 0;
      // desconta o rodapé de paginação logo abaixo
      el.style.height = `${Math.max(280, window.innerHeight - top - pad - 64)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

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
  // filtro, busca ou itens por página mudaram: volta para a página 1
  useEffect(() => setPage(1), [query, applied, size, sort]);
  const sorted = useMemo(() => {
    if (!sort) return visible;
    const { key, dir } = sort;
    return [...visible].sort((a, b) =>
      dir * (key === 'total_cents' ? a.total_cents - b.total_cents : key === 'created_at' ? a.created_at.localeCompare(b.created_at) : collator.compare(a[key], b[key])),
    );
  }, [visible, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages);
  const start = (current - 1) * size;
  const pageRows = sorted.slice(start, start + size);
  const toggleSort = (key: SortKey) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <span role="columnheader" aria-sort={sort?.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} class={`px-3 py-3 ${right ? 'text-right' : ''}`}>
      <button type="button" onClick={() => toggleSort(k)} class="inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-ink">
        {label}
        <span aria-hidden="true" class={`text-[10px] ${sort?.key === k ? '' : 'opacity-30'}`}>{sort?.key === k ? (sort.dir === 1 ? '▲' : '▼') : '▲▼'}</span>
      </button>
    </span>
  );

  // total recebido: só pago/enviado/entregue (cancelada, pendente e não paga ficam fora)
  const RECEIVED = ['paid', 'separating', 'shipped', 'delivered'];
  const total = visible.filter((o) => RECEIVED.includes(o.status)).reduce((s, o) => s + o.total_cents, 0);

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
  // status com a cor da etiqueta (mesma de orderStatusBadge)
  const badge = (status: string, label: string) => (
    <span class={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium uppercase leading-tight ${orderStatusBadge(status)}`}>{label}</span>
  );

  const Chip = ({ title, items }: { title: string; items: { label: preact.ComponentChildren; text?: string; onRemove: () => void }[] }) => (
    <span class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-ink bg-ink py-1 pl-3 pr-1.5 font-sans text-[13px] text-bone">
      <span class="text-bone/70">{title}:</span>
      {items.map((it, i) => (
        <>
          {i > 0 && <span class="text-bone/50" aria-hidden="true">|</span>}
          <span class="inline-flex items-center gap-1">
            {it.label}
            <button type="button" onClick={it.onRemove} class="grid h-5 w-5 place-items-center rounded-full hover:bg-bone/20" aria-label={`Tirar filtro ${title}: ${it.text ?? it.label}`}>
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
          {fkey === 'statuses' ? badge(value, label) : label}
        </label>
      ))}
    </div>
  );

  const chips = [
    applied.formats.length > 0 && (
      <Chip key="f" title="Formato" items={applied.formats.map((v) => ({ label: labelOf(FORMATS, v), text: labelOf(FORMATS, v), onRemove: () => remove('formats', v) }))} />
    ),
    applied.statuses.length > 0 && (
      <Chip key="s" title="Status" items={applied.statuses.map((v) => ({ label: badge(v, labelOf(STATUSES, v)), text: labelOf(STATUSES, v), onRemove: () => remove('statuses', v) }))} />
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
          {chips.length ? chips : <span class="self-center font-sans text-[13px] text-ink-muted">Todas as vendas</span>}
        </div>
      </div>

      <div class="mt-4 rounded-card border border-ink/10 bg-white p-4">
        <label class="label" for="order-search">Venda</label>
        <span class="relative block">
          <svg class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            id="order-search"
            class="field pl-11"
            type="search"
            inputMode="numeric"
            placeholder="Pesquise pelo código da venda…"
            autoComplete="off"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </span>
      </div>

      {/* uma área de rolagem só: cabeçalho, compras e totais rolam juntos pro lado */}
      <div ref={box} class="mt-4 overflow-auto rounded-card border border-ink/10 bg-white" role="table" aria-label="Vendas">
        <div class="flex min-h-full w-full min-w-fit flex-col text-sm">
          <div role="row" class={`${COLS} sticky top-0 z-10 border-b border-ink/10 bg-white text-[11px] uppercase tracking-[0.1em] text-ink-muted`}>
            <SortHead k="number" label="Venda" />
            <SortHead k="created_at" label="Data" />
            <SortHead k="customer" label="Cliente" />
            <span role="columnheader" class="px-3 py-3">Formato</span>
            <SortHead k="status_label" label="Status" />
            <SortHead k="total_cents" label="Valor" right />
            <span role="columnheader" class="px-3 py-3"><span class="sr-only">Ações</span></span>
          </div>
          {pageRows.map((o) => (
            <div role="row" key={o.number} class={`${COLS} items-center border-b border-ink/10 hover:bg-bone-50`}>
              <span role="cell" class="truncate px-3 py-3">
                <a href={`/admin/pedidos/${o.number}`} class="text-agua-dark">{orderLabel(o.number)}</a>
              </span>
              <span role="cell" class="whitespace-nowrap px-3 py-3 text-ink-muted">{new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
              <span role="cell" class="truncate px-3 py-3" title={o.customer}>{o.customer}</span>
              <span role="cell" class="px-3 py-3 text-ink-soft">{o.source === 'caixa' ? 'Física' : 'Online'}</span>
              <span role="cell" class="px-3 py-3">
                <span class={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium uppercase leading-tight ${orderStatusBadge(o.status, o.source === 'caixa' ? 'caixa' : 'web')}`}>{o.status_label}</span>
                {o.cancel_pending && <span class="mt-1 block text-[11px] font-semibold text-amber-700" title="O cliente pediu o cancelamento: abra a venda para aprovar ou recusar">! Cancelamento pendente</span>}
              </span>
              <span role="cell" class="px-3 py-3 text-right">{brl(o.total_cents)}</span>
              <span role="cell" class="px-3 py-2 text-right">
                <a href={`/admin/pedidos/${o.number}`} class="rounded-card border border-ink/20 px-3 py-1 text-[13px] hover:bg-bone-100">Editar</a>
              </span>
            </div>
          ))}
          {visible.length === 0 && <p class="p-6 text-center text-sm text-ink-muted">Nenhuma venda encontrada.</p>}
          {/* espaço em branco até os totais */}
          <div class="flex-1" aria-hidden="true" />
          <div role="row" class={`${COLS} sticky bottom-0 z-10 border-t border-ink/10 bg-bone font-sans`}>
            <span role="cell" class="whitespace-nowrap px-3 py-3">Vendas: <strong>{visible.length}</strong></span>
            <span role="cell" /><span role="cell" /><span role="cell" /><span role="cell" />
            <span role="cell" class="whitespace-nowrap px-3 py-3 text-right font-semibold" title="Soma das vendas pagas, enviadas ou entregues (canceladas e pendentes ficam fora)">{brl(total)}</span>
            <span role="cell" />
          </div>
        </div>
      </div>

      {/* paginação: itens por página, primeira/anterior/próxima/última e quantos estão aparecendo */}
      <div class="flex flex-wrap items-center justify-between gap-3 px-1 py-3 font-sans text-[13px] text-ink-muted">
        <label class="flex items-center gap-2">
          Itens por página
          <select class="rounded-card border border-ink/15 bg-white px-2 py-1 text-ink" value={size} onChange={(e) => setSize(Number((e.target as HTMLSelectElement).value))}>
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span aria-live="polite">{sorted.length ? `Exibindo ${start + 1}–${Math.min(start + size, sorted.length)} de ${sorted.length} ${sorted.length === 1 ? 'item' : 'itens'}` : 'Nenhum item'}</span>
        <span class="flex items-center gap-1">
          <button type="button" class={PAGE_BTN} disabled={current <= 1} onClick={() => setPage(1)} aria-label="Primeira página" title="Primeira página"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 18l-6-6 6-6" /><path d="M7 6v12" /></svg></button>
          <button type="button" class={PAGE_BTN} disabled={current <= 1} onClick={() => setPage(current - 1)} aria-label="Página anterior" title="Anterior"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg></button>
          <span class="px-2 text-ink">{current} / {pages}</span>
          <button type="button" class={PAGE_BTN} disabled={current >= pages} onClick={() => setPage(current + 1)} aria-label="Próxima página" title="Próxima"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg></button>
          <button type="button" class={PAGE_BTN} disabled={current >= pages} onClick={() => setPage(pages)} aria-label="Última página" title="Última página"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 18l6-6-6-6" /><path d="M17 6v12" /></svg></button>
        </span>
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
              <p class="mt-2 text-[12px] text-ink-muted">Sem "Data (até)", mostra só as vendas do dia escolhido.</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 border-t border-ink/10 bg-[#f2f1f6] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY);
                setApplied(EMPTY);
                close();
              }}
              class="rounded-full border border-ink/15 bg-white py-3.5 font-sans text-[16px] text-ink hover:border-ink">
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
