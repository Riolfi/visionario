/**
 * Busca instantânea das listas da área administrativa (como em Produtos):
 * mostra só as linhas cujo `data-name` tem todas as palavras digitadas, sem
 * diferenciar acento nem maiúscula. `extra` soma outros filtros (selects).
 */
export const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function enableListSearch(opts: {
  input: string;
  rows: string;
  count?: string;
  noResults?: string;
  /** [singular, plural] para o contador ("3 de 10 ofertas") */
  noun: [string, string];
  extra?: (row: HTMLElement) => boolean;
  /** ids de outros campos que também refiltram (selects de filtro) */
  also?: string[];
}) {
  const input = document.getElementById(opts.input) as HTMLInputElement | null;
  const rows = Array.from(document.querySelectorAll<HTMLElement>(opts.rows));
  const count = opts.count ? document.getElementById(opts.count) : null;
  const empty = opts.noResults ? document.getElementById(opts.noResults) : null;
  const run = () => {
    const words = fold(input?.value ?? '').split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of rows) {
      const name = fold(row.dataset.name ?? '');
      const ok = words.every((w) => name.includes(w)) && (opts.extra?.(row) ?? true);
      row.hidden = !ok;
      row.toggleAttribute('data-out', !ok); // paginação (lib/data-table) conta só as que sobraram
      if (ok) shown++;
    }
    document.dispatchEvent(new Event('table:filter'));
    const total = rows.length;
    const [one, many] = opts.noun;
    if (count) count.textContent = shown === total ? `${total} ${total === 1 ? one : many}` : `${shown} de ${total} ${many}`;
    empty?.classList.toggle('hidden', shown > 0 || !total);
  };
  input?.addEventListener('input', run);
  for (const id of opts.also ?? []) document.getElementById(id)?.addEventListener('change', run);
  return run;
}
