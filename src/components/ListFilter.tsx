import { useRef, useState } from 'preact/hooks';

/**
 * Filtro das listas da área administrativa, igual ao de Compras: botão com
 * funil, pop-up "Filtro" (multi-seleção por seção, Limpar/Filtrar) e os
 * filtros aplicados como etiquetas removíveis ao lado do botão.
 * Quem filtra as linhas é a página: a cada mudança chama `window[onApply]`
 * com { chave: [valores] } (vazio = todos).
 */
export interface FilterSection {
  key: string;
  title: string;
  options: [string, string][];
}

type Applied = Record<string, string[]>;

const FILTER_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" /></svg>
);
const X_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

export default function ListFilter({ sections, onApply, emptyLabel }: { sections: FilterSection[]; onApply: string; emptyLabel: string }) {
  const empty = (): Applied => Object.fromEntries(sections.map((s) => [s.key, []]));
  const [applied, setAppliedState] = useState<Applied>(empty);
  const [draft, setDraft] = useState<Applied>(empty);
  const [open, setOpen] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const setApplied = (a: Applied) => {
    setAppliedState(a);
    (window as unknown as Record<string, (a: Applied) => void>)[onApply]?.(a);
  };
  const close = () => dialog.current?.close();
  const labelOf = (s: FilterSection, v: string) => s.options.find(([k]) => k === v)?.[1] ?? v;
  const toggle = (key: string, v: string) =>
    setDraft((d) => ({ ...d, [key]: d[key]!.includes(v) ? d[key]!.filter((x) => x !== v) : [...d[key]!, v] }));

  const chips = sections.filter((s) => applied[s.key]!.length);

  return (
    <>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setDraft(applied);
            setOpen(null);
            dialog.current?.showModal();
          }}
          class={`grid h-9 w-9 shrink-0 place-items-center rounded-full border ${chips.length ? 'border-ink bg-ink text-bone' : 'border-ink/20 text-ink hover:border-ink'}`}
          aria-label="Filtro"
          title="Filtro"
        >
          {FILTER_ICON}
        </button>
        <div class="flex min-w-0 flex-1 gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.length ? (
            chips.map((s) => (
              <span key={s.key} class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-ink bg-ink py-1 pl-3 pr-1.5 font-sans text-[13px] text-bone">
                <span class="text-bone/70">{s.title}:</span>
                {applied[s.key]!.map((v, i) => (
                  <>
                    {i > 0 && <span class="text-bone/50" aria-hidden="true">|</span>}
                    <span class="inline-flex items-center gap-1">
                      {labelOf(s, v)}
                      <button
                        type="button"
                        onClick={() => setApplied({ ...applied, [s.key]: applied[s.key]!.filter((x) => x !== v) })}
                        class="grid h-5 w-5 place-items-center rounded-full hover:bg-bone/20"
                        aria-label={`Tirar filtro ${s.title}: ${labelOf(s, v)}`}
                      >
                        {X_ICON}
                      </button>
                    </span>
                  </>
                ))}
              </span>
            ))
          ) : (
            <span class="self-center font-sans text-[13px] text-ink-muted">{emptyLabel}</span>
          )}
        </div>
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
            {sections.map((s) => (
              <div key={s.key} class="rounded-[18px] bg-white">
                <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-4 text-left" aria-expanded={open === s.key} onClick={() => setOpen(open === s.key ? null : s.key)}>
                  <span class="font-sans text-[16px] font-medium text-ink">{s.title}</span>
                  <span class="flex min-w-0 items-center gap-2 font-sans text-[14px] text-ink-muted">
                    <span class="truncate">{draft[s.key]!.length ? draft[s.key]!.map((v) => labelOf(s, v)).join(', ') : 'Todos'}</span>
                    <svg class={`shrink-0 transition-transform ${open === s.key ? 'rotate-90' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  </span>
                </button>
                {open === s.key && (
                  <div class="space-y-1 border-t border-ink/10 px-4 py-3">
                    {s.options.map(([value, label]) => (
                      <label key={value} class="flex cursor-pointer items-center gap-3 rounded-card px-1 py-2 text-[15px] hover:bg-bone-50">
                        <input type="checkbox" class="h-4 w-4" checked={draft[s.key]!.includes(value)} onChange={() => toggle(s.key, value)} />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div class="grid grid-cols-2 gap-3 border-t border-ink/10 bg-[#f2f1f6] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
            <button
              type="button"
              onClick={() => {
                setDraft(empty());
                setApplied(empty());
                close();
              }}
              class="rounded-full border border-ink/15 bg-white py-3.5 font-sans text-[16px] text-ink hover:border-ink"
            >
              Limpar
            </button>
            <button
              type="button"
              onClick={() => {
                setApplied(draft);
                close();
              }}
              class="rounded-full bg-ink py-3.5 font-sans text-[16px] font-semibold text-bone"
            >
              Filtrar
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
