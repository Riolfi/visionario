import { useRef, useState } from 'preact/hooks';

interface Node {
  id: string;
  name: string;
  slug: string;
  thumb: string;
  count: number;
  is_active: boolean;
  children: Node[];
}

type Flat = { node: Node; depth: 0 | 1; rootId: string };
type Mode = 'before' | 'after' | 'inside';
type Hint = { overId: string; mode: Mode } | null;

function clone(nodes: Node[]): Node[] {
  return nodes.map((r) => ({ ...r, children: r.children.map((c) => ({ ...c })) }));
}

function flatten(nodes: Node[]): Flat[] {
  const out: Flat[] = [];
  for (const r of nodes) {
    out.push({ node: r, depth: 0, rootId: r.id });
    for (const c of r.children) out.push({ node: c, depth: 1, rootId: r.id });
  }
  return out;
}

function detach(nodes: Node[], id: string): [Node[], Node | null, boolean] {
  const next = clone(nodes);
  const ri = next.findIndex((r) => r.id === id);
  if (ri >= 0) {
    const [n] = next.splice(ri, 1);
    return [next, n!, (n!.children?.length ?? 0) > 0];
  }
  for (const r of next) {
    const ci = r.children.findIndex((c) => c.id === id);
    if (ci >= 0) {
      const [n] = r.children.splice(ci, 1);
      return [next, n!, false];
    }
  }
  return [next, null, false];
}

function locate(nodes: Node[], id: string): { root: number; child: number | null } | null {
  const ri = nodes.findIndex((r) => r.id === id);
  if (ri >= 0) return { root: ri, child: null };
  for (let i = 0; i < nodes.length; i++) {
    const ci = nodes[i]!.children.findIndex((c) => c.id === id);
    if (ci >= 0) return { root: i, child: ci };
  }
  return null;
}

export default function CategoryTree({ tree }: { tree: Node[] }) {
  const [nodes, setNodes] = useState<Node[]>(tree);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // estado do arraste em refs (não depende do flush do Preact entre
  // dragstart → dragover → drop, que disparam muito rápido) + um contador
  // só para forçar o re-render dos indicadores visuais.
  const dragIdRef = useRef<string | null>(null);
  const hintRef = useRef<Hint>(null);
  const [, bump] = useState(0);
  const redraw = () => bump((n) => n + 1);
  const dragId = dragIdRef.current;
  const hint = hintRef.current;
  const setDragId = (v: string | null) => {
    dragIdRef.current = v;
    redraw();
  };
  const setHint = (v: Hint) => {
    hintRef.current = v;
    redraw();
  };

  async function apply(next: Node[]) {
    setNodes(next);
    setSaving(true);
    setError(null);
    const res = await fetch('/api/admin/categories?action=tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: next.map((r) => ({ id: r.id, children: r.children.map((c) => ({ id: c.id })) })),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || 'Não foi possível salvar a hierarquia.');
      setNodes(tree);
    }
  }

  /** insere `node` relativo a `targetId` no modo indicado */
  function place(base: Node[], node: Node, hadChildren: boolean, target: string, mode: Mode) {
    const next = base;
    if (target === '__end__' || !locate(next, target)) {
      next.push(node);
      return next;
    }
    const loc = locate(next, target)!;

    if (mode === 'inside') {
      if (loc.child === null && !hadChildren) {
        node.children = [];
        next[loc.root]!.children.push(node);
      } else {
        next.push(node);
      }
      return next;
    }

    const offset = mode === 'after' ? 1 : 0;
    if (loc.child === null) {
      next.splice(loc.root + offset, 0, node); // vira/continua raiz
    } else if (hadChildren) {
      next.push(node); // não pode aninhar → raiz no fim
    } else {
      node.children = [];
      next[loc.root]!.children.splice(loc.child + offset, 0, node);
    }
    return next;
  }

  function doDrop() {
    const did = dragIdRef.current;
    const h = hintRef.current;
    reset();
    if (!did || !h || did === h.overId) return;
    const [without, node, hadChildren] = detach(nodes, did);
    if (!node) return;
    apply(place(without, node, hadChildren, h.overId, h.mode));
  }

  function reset() {
    setDragId(null);
    setHint(null);
  }

  // --- controles por botão (funcionam sem drag) ---
  function move(id: string, dir: -1 | 1) {
    const flat = flatten(nodes);
    const i = flat.findIndex((f) => f.node.id === id);
    const cur = flat[i];
    if (!cur) return;
    const siblings = flat.filter((f) => f.depth === cur.depth && (cur.depth === 0 || f.rootId === cur.rootId));
    const si = siblings.findIndex((f) => f.node.id === id);
    const target = siblings[si + dir];
    if (!target) return;
    const [without, n, had] = detach(nodes, id);
    if (!n) return;
    apply(place(without, n, had, target.node.id, dir === -1 ? 'before' : 'after'));
  }

  function promote(id: string) {
    const [without, n] = detach(nodes, id);
    if (!n) return;
    n.children = n.children ?? [];
    without.push(n);
    apply(without);
  }

  function nest(id: string, rootId: string) {
    if (!rootId) return;
    const [without, n, had] = detach(nodes, id);
    if (!n || had) return;
    n.children = [];
    const root = without.find((r) => r.id === rootId);
    if (root) root.children.push(n);
    apply(without);
  }

  const roots = nodes;

  function Row({ node, depth }: Flat) {
    const isDragged = dragId === node.id;
    const hasKids = depth === 0 && node.children.length > 0;
    const inside = hint?.overId === node.id && hint.mode === 'inside' && depth === 0 && !isDragged;
    const line = hint?.overId === node.id && hint.mode !== 'inside' && !isDragged ? hint.mode : null;
    return (
      <li class="border-t border-ink/10 first:border-t-0">
        {line === 'before' && <div class="h-1 bg-agua" />}
        <div
          draggable
          onDragStart={(e) => {
            setDragId(node.id);
            e.dataTransfer?.setData('text/plain', node.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={reset}
          onDragEnter={(e) => e.preventDefault()}
          onDragOver={(e) => {
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = (e.clientY - r.top) / r.height;
            setHint({ overId: node.id, mode: y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside' });
          }}
          onDrop={(e) => {
            e.preventDefault();
            doDrop();
          }}
          class={`flex items-center gap-2 px-3 py-2 transition-colors hover:bg-bone-50 ${depth === 1 ? 'pl-8 sm:pl-12' : ''} ${
            isDragged ? 'opacity-40' : ''
          } ${inside ? 'bg-agua-wash ring-1 ring-inset ring-agua' : ''}`}
        >
          <span class="cursor-grab select-none px-1 text-lg leading-none text-ink-muted" title="Arraste para mover" aria-hidden="true">⠿</span>

          <div class="h-10 w-14 shrink-0 overflow-hidden rounded-card bg-bone-200">
            {node.thumb && <img src={node.thumb} alt="" draggable={false} class="pointer-events-none h-full w-full object-cover" />}
          </div>

          <div class="min-w-0 flex-1">
            <span class="block truncate font-medium">
              {node.name}
              {!node.is_active && <span class="ml-1 rounded-full bg-bone-200 px-2 py-0.5 align-middle text-[10px] uppercase text-ink-muted">Inativa</span>}
            </span>
            <p class="truncate text-[12px] text-ink-muted">
              {depth === 0
                ? `raiz · ${node.children.length} ${node.children.length === 1 ? 'subcategoria' : 'subcategorias'}`
                : `subcategoria · ${node.count} ${node.count === 1 ? 'produto' : 'produtos'}`}
            </p>
          </div>

          {/* controles sem drag */}
          <div class="flex shrink-0 items-center gap-1">
            <button type="button" class="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-bone-200 hover:text-ink disabled:opacity-25" onClick={() => move(node.id, -1)} aria-label="Mover para cima">↑</button>
            <button type="button" class="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-bone-200 hover:text-ink disabled:opacity-25" onClick={() => move(node.id, 1)} aria-label="Mover para baixo">↓</button>
            {depth === 1 && (
              <button type="button" class="rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-bone-200 hover:text-ink" onClick={() => promote(node.id)} title="Transformar em categoria raiz">↤ raiz</button>
            )}
            {depth === 0 && !hasKids && roots.length > 1 && (
              <select
                class="rounded border border-ink/20 bg-bone-50 px-1 py-1 text-[11px] text-ink-soft"
                onChange={(e) => {
                  nest(node.id, (e.target as HTMLSelectElement).value);
                  (e.target as HTMLSelectElement).value = '';
                }}
              >
                <option value="">aninhar em…</option>
                {roots.filter((r) => r.id !== node.id).map((r) => <option value={r.id}>{r.name}</option>)}
              </select>
            )}
            <a href={`/admin/categorias/${node.id}`} draggable={false} class="ml-1 rounded-card border border-ink/20 px-2 py-1 text-[12px] hover:bg-bone-100 sm:px-3 sm:text-[13px]">Editar</a>
          </div>
        </div>
        {line === 'after' && <div class="h-1 bg-agua" />}
      </li>
    );
  }

  return (
    <div>
      <div class="mb-4 flex items-center justify-between gap-3">
        <p class="font-sans text-sm text-ink-muted">
          {flatten(nodes).length} categorias{saving && ' · salvando…'}
        </p>
        <a href="/admin/categorias/nova" class="btn-primary">Nova categoria</a>
      </div>
      {error && <p class="mb-3 rounded-card border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <p class="mb-4 text-[12px] text-ink-muted">
        Arraste pela alça <b>⠿</b> (ou use ↑ ↓, <b>↤ raiz</b> e <b>aninhar em…</b>). Soltar
        <b> no meio</b> de uma raiz aninha; soltar <b>nas bordas</b> reordena. Uma raiz com
        subcategorias não pode virar subcategoria.
      </p>

      <div class="rounded-card border border-ink/10 bg-white">
      <div class="flex border-b border-ink/10 px-3 py-3 text-[11px] uppercase tracking-[0.1em] text-ink-muted">
        <span class="flex-1 pl-8">Nome</span>
        <span class="sr-only">Ações</span>
      </div>
      <ul
        class=""
        onDragOver={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setHint({ overId: '__end__', mode: 'after' });
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          doDrop();
        }}
      >
        {flatten(nodes).map((f) => (
          <Row {...f} key={f.node.id} />
        ))}
      </ul>
      </div>
    </div>
  );
}
