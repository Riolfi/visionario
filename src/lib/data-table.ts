/**
 * Tabelas da área administrativa: ordenação por coluna e paginação.
 *
 * Marcação (Astro):
 *   <div data-table class="data-table-box …"><table>…</table></div>
 *   - <th data-sort="text|number|date"> vira ordenável (clique alterna ▲/▼);
 *   - o valor de cada célula é td[data-sort] (se houver) ou o texto dela.
 * O rodapé (itens por página 10/20/30/50, ⏮ ◀ ▶ ⏭ e "Exibindo 1–10 de N")
 * entra logo abaixo da caixa; o cabeçalho fica preso no topo dela (CSS
 * .data-table-box em global.css) e as linhas rolam no meio.
 *
 * Filtros/busca escondem uma linha com o atributo data-out e avisam com o
 * evento "table:filter" (lib/list-search faz isso): a paginação conta só as
 * linhas que sobraram e volta para a página 1.
 */
const SIZES = [10, 20, 30, 50];
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function cellValue(row: HTMLTableRowElement, col: number): string {
  const cell = row.cells[col];
  return (cell?.dataset.sort ?? cell?.textContent ?? '').trim();
}

function compare(type: string, a: string, b: string): number {
  if (type === 'number') return (parseFloat(a) || 0) - (parseFloat(b) || 0);
  if (type === 'date') return (Date.parse(a) || 0) - (Date.parse(b) || 0);
  return collator.compare(a, b);
}

const BTN = 'grid h-8 w-8 place-items-center rounded-card border border-ink/15 text-ink hover:bg-bone-100 disabled:cursor-not-allowed disabled:opacity-30';

export function enableDataTable(box: HTMLElement) {
  const table = box.querySelector('table');
  const tbody = table?.tBodies[0];
  if (!table || !tbody) return;
  const rows = () => [...tbody.rows];
  let page = 1;
  let size = 10;
  let sortCol = -1;
  let dir: 1 | -1 = 1;

  // ---- ordenação no cabeçalho ----
  const headers = [...table.querySelectorAll<HTMLTableCellElement>('thead th[data-sort]')];
  for (const th of headers) {
    const label = th.innerHTML;
    th.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-ink';
    btn.innerHTML = `<span>${label}</span><span data-arrow aria-hidden="true" class="text-[10px] opacity-30">▲▼</span>`;
    th.append(btn);
    th.setAttribute('aria-sort', 'none');
    btn.addEventListener('click', () => {
      const col = th.cellIndex;
      dir = sortCol === col ? (dir === 1 ? -1 : 1) : 1;
      sortCol = col;
      const type = th.dataset.sort ?? 'text';
      const sorted = rows().sort((a, b) => dir * compare(type, cellValue(a, col), cellValue(b, col)));
      tbody.append(...sorted);
      for (const h of headers) {
        const on = h === th;
        const arrow = h.querySelector<HTMLElement>('[data-arrow]')!;
        arrow.textContent = on ? (dir === 1 ? '▲' : '▼') : '▲▼';
        arrow.classList.toggle('opacity-30', !on);
        h.setAttribute('aria-sort', on ? (dir === 1 ? 'ascending' : 'descending') : 'none');
      }
      page = 1;
      refresh();
    });
  }

  // ---- rodapé de paginação ----
  const footer = document.createElement('div');
  footer.className = 'data-table-footer flex flex-wrap items-center justify-between gap-3 px-1 py-3 font-sans text-[13px] text-ink-muted';
  footer.innerHTML = `
    <label class="flex items-center gap-2">Itens por página
      <select data-size class="rounded-card border border-ink/15 bg-white px-2 py-1 text-ink">${SIZES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
    </label>
    <span data-info aria-live="polite"></span>
    <span class="flex items-center gap-1">
      <button type="button" data-go="first" class="${BTN}" aria-label="Primeira página" title="Primeira página">⏮</button>
      <button type="button" data-go="prev" class="${BTN}" aria-label="Página anterior" title="Anterior">◀</button>
      <span data-page class="px-2 text-ink"></span>
      <button type="button" data-go="next" class="${BTN}" aria-label="Próxima página" title="Próxima">▶</button>
      <button type="button" data-go="last" class="${BTN}" aria-label="Última página" title="Última página">⏭</button>
    </span>`;
  box.after(footer);
  const sizeSel = footer.querySelector<HTMLSelectElement>('[data-size]')!;
  sizeSel.addEventListener('change', () => {
    size = Number(sizeSel.value);
    page = 1;
    refresh();
  });
  footer.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const pages = Math.max(1, Math.ceil(visible().length / size));
      page = { first: 1, prev: page - 1, next: page + 1, last: pages }[b.dataset.go as 'first'] ?? 1;
      refresh();
      box.scrollTop = 0;
    }),
  );

  const visible = () => rows().filter((r) => !r.hasAttribute('data-out'));
  function refresh() {
    const live = visible();
    const pages = Math.max(1, Math.ceil(live.length / size));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * size;
    for (const r of rows()) r.hidden = true;
    live.slice(start, start + size).forEach((r) => (r.hidden = false));
    const info = footer.querySelector('[data-info]')!;
    info.textContent = live.length
      ? `Exibindo ${start + 1}–${Math.min(start + size, live.length)} de ${live.length} ${live.length === 1 ? 'item' : 'itens'}`
      : 'Nenhum item';
    footer.querySelector('[data-page]')!.textContent = `${page} / ${pages}`;
    const at = (k: string) => footer.querySelector<HTMLButtonElement>(`[data-go="${k}"]`)!;
    at('first').disabled = at('prev').disabled = page <= 1;
    at('next').disabled = at('last').disabled = page >= pages;
  }

  document.addEventListener('table:filter', () => {
    page = 1;
    refresh();
  });
  refresh();
}

/** Liga todas as tabelas marcadas com data-table na página. */
export function enableDataTables() {
  document.querySelectorAll<HTMLElement>('[data-table]').forEach(enableDataTable);
}
