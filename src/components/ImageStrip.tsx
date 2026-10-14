import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Pré-visualização das fotos do produto numa faixa horizontal (rola para o
 * lado quando não cabe). Reordenar: arrastar a foto para o lado — com o mouse
 * na hora; no toque, segurando um instante antes (deslizar direto rola a
 * faixa). Uma barra mostra onde a foto vai entrar. A primeira é a capa.
 */
interface Props {
  images: string[];
  onChange: (images: string[]) => void;
  /** só mostra (sem arrastar nem remover) — cargo sem "Cadastrar e editar produtos" */
  readOnly?: boolean;
}

const HOLD_MS = 280; // toque: segurar antes de arrastar
const MOVE_TOLERANCE = 8; // px que contam como "ainda parado"

export default function ImageStrip({ images, onChange, readOnly = false }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; x: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const pending = useRef<{ index: number; x: number; y: number; timer?: number; touch: boolean } | null>(null);

  // enquanto arrasta no toque, impede a faixa/página de rolar
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const block = (e: TouchEvent) => dragRef.current && e.cancelable && e.preventDefault();
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  /** posição de inserção (0..n) pela coordenada x do ponteiro */
  function insertionAt(clientX: number): number {
    const items = Array.from(strip.current?.querySelectorAll<HTMLElement>('[data-thumb]') ?? []);
    return items.filter((it) => {
      const r = it.getBoundingClientRect();
      return r.left + r.width / 2 < clientX;
    }).length;
  }

  /** x da barra indicadora, nas coordenadas do conteúdo da faixa */
  function indicatorX(to: number): number {
    const items = Array.from(strip.current?.querySelectorAll<HTMLElement>('[data-thumb]') ?? []);
    if (!items.length) return 0;
    if (to < items.length) return items[to]!.offsetLeft - 6;
    const last = items[items.length - 1]!;
    return last.offsetLeft + last.offsetWidth + 6;
  }

  function start(index: number, e: PointerEvent) {
    if ((e.target as HTMLElement).closest('[data-remove]')) return;
    const touch = e.pointerType !== 'mouse';
    pending.current = { index, x: e.clientX, y: e.clientY, touch };
    // mouse: segue recebendo o movimento mesmo saindo da faixa
    if (!touch) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (touch) {
      pending.current.timer = window.setTimeout(() => {
        const p = pending.current;
        if (!p) return;
        setDrag({ from: p.index, to: p.index, x: p.x });
        navigator.vibrate?.(15);
      }, HOLD_MS);
    }
  }

  function move(e: PointerEvent) {
    const p = pending.current;
    if (!p) return;
    const d = dragRef.current;
    if (!d) {
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE;
      if (!moved) return;
      if (p.touch) {
        // mexeu antes do tempo: é rolagem, não arraste
        clearTimeout(p.timer);
        pending.current = null;
        return;
      }
      setDrag({ from: p.index, to: insertionAt(e.clientX), x: e.clientX });
      return;
    }
    // perto das bordas, rola a faixa junto
    const el = strip.current!;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left + 32) el.scrollLeft -= 12;
    else if (e.clientX > r.right - 32) el.scrollLeft += 12;
    setDrag({ ...d, to: insertionAt(e.clientX), x: e.clientX });
  }

  function end() {
    const p = pending.current;
    if (p?.timer) clearTimeout(p.timer);
    pending.current = null;
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const target = d.to > d.from ? d.to - 1 : d.to;
    if (target === d.from) return;
    const next = [...images];
    const [moved] = next.splice(d.from, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  }

  if (!images.length) return null;

  return (
    <div
      ref={strip}
      class="relative mt-3 flex gap-3 overflow-x-auto pb-2 pt-1"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={(e) => drag && e.preventDefault()}
    >
      {images.map((url, i) => (
        <div
          key={url}
          data-thumb
          onPointerDown={readOnly ? undefined : (e) => start(i, e)}
          class={`relative h-24 w-24 shrink-0 ${readOnly ? '' : 'cursor-grab'} select-none overflow-hidden rounded-card border border-ink/10 bg-bone-100 transition-opacity ${drag?.from === i ? 'opacity-40' : ''}`}
        >
          <img src={url} alt="" draggable={false} class="pointer-events-none h-full w-full object-cover" loading="lazy" />
          {i === 0 && (
            <span class="absolute bottom-1 left-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] uppercase text-bone">Capa</span>
          )}
          {!readOnly && <button
            type="button"
            data-remove
            onClick={() => onChange(images.filter((u) => u !== url))}
            class="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-blush/70 text-[12px] leading-none text-white hover:bg-blush"
            aria-label="Remover imagem"
          >
            ✕
          </button>}
        </div>
      ))}
      {drag && drag.to !== drag.from && drag.to !== drag.from + 1 && (
        <span
          class="pointer-events-none absolute bottom-2 top-1 w-1 rounded-full bg-blush"
          style={{ left: `${indicatorX(drag.to) - 2}px` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
