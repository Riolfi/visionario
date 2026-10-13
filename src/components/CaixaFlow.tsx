import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import CameraScanner from './CameraScanner';
import { CHECK_ICON_PATH, SCAN_BTN, SCAN_ICON_PATH, useHasCamera } from './CameraScanButton';
import { brl, orderLabel } from '../lib/format';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../lib/types';

interface Line {
  product_id: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
  stock: number;
  image: string | null;
}

interface ScanResult {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
  is_active: boolean;
  image: string | null;
}

interface Done {
  order_number: string;
  total_cents: number;
  received_cents: number | null;
  method: PaymentMethod;
}

interface PixWait {
  order_id: string;
  order_number: string;
  total_cents: number;
  pix: { qrCode: string; qrCodeBase64: string; ticketUrl: string } | null;
}

const METHODS: PaymentMethod[] = ['cash', 'pix', 'debit_card', 'credit_card'];

function parseReaisToCents(raw: string): number | null {
  const clean = raw.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** minúsculas e sem acento, pra busca por nome */
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const TRASH_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);

export default function CaixaFlow({ products = [] }: { products?: ScanResult[] }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const hasCamera = useHasCamera();
  const [scanMsg, setScanMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  // Leitor pela câmera (celular/tablet). Cada abertura começa uma lista NOVA
  // (`session`), separada da venda: os produtos lidos só entram no Caixa ao
  // confirmar, somando ao que já estava. null = leitor fechado.
  const [session, setSession] = useState<Line[] | null>(null);
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [pixWait, setPixWait] = useState<PixWait | null>(null);

  const scanRef = useRef<HTMLInputElement>(null);
  // No PC o campo fica sempre pronto pro leitor USB. Em tela de toque, focar
  // abriria o teclado do celular sozinho — lá o foco é só quando a pessoa toca.
  const focusScanner = () => {
    if (matchMedia('(pointer: coarse)').matches) return;
    window.setTimeout(() => scanRef.current?.focus(), 0);
  };

  useEffect(() => {
    focusScanner();
  }, []);

  // ---- Polling do Pix: enquanto aguarda, checa a cada 3s se já confirmou ----
  useEffect(() => {
    if (!pixWait) return;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/payments/status?id=${pixWait.order_id}`);
        const data = (await res.json().catch(() => ({}))) as { status?: string };
        if (data.status === 'paid') {
          window.clearInterval(id);
          setDone({
            order_number: pixWait.order_number,
            total_cents: pixWait.total_cents,
            received_cents: null,
            method: 'pix',
          });
          setPixWait(null);
        } else if (data.status === 'failed' || data.status === 'cancelled') {
          window.clearInterval(id);
          setError('O Pix não foi confirmado. Tente de novo.');
          setPixWait(null);
        }
      } catch {
        /* falha de rede num tick só: tenta de novo no próximo */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [pixWait]);

  const total = useMemo(
    () => lines.reduce((s, l) => s + l.unit_price_cents * l.quantity, 0),
    [lines],
  );
  const count = useMemo(() => lines.reduce((s, l) => s + l.quantity, 0), [lines]);
  const receivedCents = method === 'cash' ? parseReaisToCents(received) : null;
  const changeCents = receivedCents == null ? null : receivedCents - total;
  const overStock = lines.some((l) => l.quantity > l.stock);

  async function submitScan(e: Event) {
    e.preventDefault();
    await addByCode(scan.trim());
  }

  /** Produto pelo código de barras (mesma rota do leitor USB). */
  async function findByCode(code: string): Promise<ScanResult | 'not_found' | 'error'> {
    try {
      const res = await fetch(`/api/admin/products/by-barcode?code=${encodeURIComponent(code)}`);
      if (res.status === 404) return 'not_found';
      if (!res.ok) return 'error';
      return (await res.json()) as ScanResult;
    } catch {
      return 'error';
    }
  }

  const toLine = (p: ScanResult, quantity = 1): Line => ({
    product_id: p.id,
    name: p.name,
    unit_price_cents: p.price_cents,
    quantity,
    stock: p.stock,
    image: p.image,
  });

  // ---- limite de estoque: venda + leitura em andamento nunca passam do estoque
  const saleQty = (id: string) => lines.find((l) => l.product_id === id)?.quantity ?? 0;
  const sessionQtyOf = (id: string) => session?.find((l) => l.product_id === id)?.quantity ?? 0;
  /** Motivo pra NÃO deixar pôr mais uma unidade (ou null se pode). */
  function stockBlock(p: ScanResult, extra = 0): string | null {
    if (p.stock <= 0) return `${p.name} está sem estoque.`;
    if (saleQty(p.id) + extra >= p.stock) {
      return `${p.name} já atingiu o limite do estoque (${p.stock} ${p.stock === 1 ? 'unidade' : 'unidades'}).`;
    }
    return null;
  }

  // busca por nome: todas as palavras no nome, sem acento/maiúscula
  const matches = useMemo(() => {
    const words = fold(nameQuery).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return products.filter((p) => words.every((w) => fold(p.name).includes(w))).slice(0, 8);
  }, [nameQuery, products]);

  function addFromSearch(p: ScanResult) {
    const block = stockBlock(p);
    if (block) return setScanMsg({ tone: 'err', text: block });
    setLines((cur) => mergeLines(cur, [toLine(p)]));
    setScanMsg({ tone: 'ok', text: `${p.name} adicionado` });
    setNameQuery('');
  }

  /** Soma `add` em `cur` (mesmo produto → soma quantidade). */
  const mergeLines = (cur: Line[], add: Line[]) => {
    const next = [...cur];
    for (const l of add) {
      const i = next.findIndex((x) => x.product_id === l.product_id);
      if (i >= 0) next[i] = { ...next[i]!, quantity: next[i]!.quantity + l.quantity };
      else next.push(l);
    }
    return next;
  };

  // ---- leitor (câmera): lista própria até confirmar ----------------------
  async function sessionScan(code: string) {
    const p = await findByCode(code);
    if (p === 'not_found') return setSessionMsg(`Código ${code} não está cadastrado.`);
    if (p === 'error') return setSessionMsg('Erro ao buscar o produto. Tente de novo.');
    const block = stockBlock(p, sessionQtyOf(p.id));
    if (block) return setSessionMsg(block);
    setSessionMsg(null);
    setSession((cur) => (cur ? mergeLines(cur, [toLine(p)]) : cur));
  }
  const sessionQty = (id: string, qty: number) =>
    setSession((cur) =>
      !cur
        ? cur
        : qty <= 0
          ? cur.filter((l) => l.product_id !== id)
          : cur.map((l) => (l.product_id === id ? { ...l, quantity: Math.min(qty, l.stock - saleQty(id)) } : l)),
    );
  function confirmSession() {
    if (!session?.length) return;
    setLines((cur) => mergeLines(cur, session));
    setScanMsg(null);
    setSession(null);
  }
  function closeSession() {
    if (session?.length && !confirm(`Descartar ${session.length === 1 ? 'o produto lido' : `os ${session.length} produtos lidos`}? Eles não entram no caixa.`)) return;
    setSession(null);
  }

  /** Campo "Produto" (leitor USB/Bluetooth ou digitação): soma 1 na venda. */
  async function addByCode(code: string) {
    if (!code || busy) return;
    setScanMsg(null);
    const p = await findByCode(code);
    if (p === 'not_found') {
      setScanMsg({ tone: 'err', text: `Código ${code} não está cadastrado.` });
      setScan('');
    } else if (p === 'error') {
      setScanMsg({ tone: 'err', text: 'Erro ao buscar o produto. Tente de novo.' });
    } else {
      const block = stockBlock(p);
      if (block) setScanMsg({ tone: 'err', text: block });
      else {
        setLines((cur) => mergeLines(cur, [toLine(p)]));
        setScanMsg({ tone: 'ok', text: `${p.name} adicionado` });
      }
      setScan('');
    }
    focusScanner();
  }

  const setQty = (id: string, qty: number) =>
    setLines((cur) =>
      qty <= 0
        ? cur.filter((l) => l.product_id !== id)
        : cur.map((l) => (l.product_id === id ? { ...l, quantity: Math.max(1, Math.min(qty, l.stock)) } : l)),
    );

  function resetSale() {
    setLines([]);
    setReceived('');
    setScan('');
    setScanMsg(null);
    setError(null);
    setDone(null);
    setCancelled(false);
    setPixWait(null);
    setMethod('cash');
    focusScanner();
  }

  async function finalize() {
    if (!lines.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (method === 'pix') {
        const res = await fetch('/api/admin/caixa', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'pix_charge',
            items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
          order_id?: string;
          order_number?: string;
          total_cents?: number;
          pix?: PixWait['pix'];
        };
        if (!res.ok || data.error || !data.order_number) {
          setError(data.error || 'Não foi possível gerar o Pix.');
          return;
        }
        if (data.status === 'approved') {
          setDone({
            order_number: data.order_number,
            total_cents: data.total_cents ?? total,
            received_cents: null,
            method: 'pix',
          });
          return;
        }
        // pending: mostra o QR e espera a confirmação (polling acima)
        setPixWait({
          order_id: data.order_id ?? '',
          order_number: data.order_number,
          total_cents: data.total_cents ?? total,
          pix: data.pix ?? null,
        });
        return;
      }

      const res = await fetch('/api/admin/caixa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method,
          items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; order_number?: string; total_cents?: number };
      if (!res.ok || !data.order_number) {
        setError(data.error || 'Não foi possível registrar a venda.');
        return;
      }
      setDone({
        order_number: data.order_number,
        total_cents: data.total_cents ?? total,
        received_cents: receivedCents,
        method,
      });
    } catch {
      setError('Sem conexão com o servidor.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelPix() {
    if (!pixWait || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/caixa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_pix', order_number: pixWait.order_number }),
      });
    } catch {
      /* mesmo se a chamada falhar, deixa o operador tentar de novo */
    } finally {
      setPixWait(null);
      setBusy(false);
      focusScanner();
    }
  }

  async function cancelSale() {
    if (!done || busy) return;
    if (!window.confirm('Cancelar esta venda e devolver os itens ao estoque?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/caixa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', order_number: done.order_number }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok || !data.ok) {
        setError(data.error || 'Não foi possível cancelar.');
        return;
      }
      setCancelled(true);
    } catch {
      setError('Sem conexão com o servidor.');
    } finally {
      setBusy(false);
    }
  }

  // ---- tela de venda concluída ----------------------------------------------
  if (done) {
    return (
      <div class="mx-auto max-w-lg rounded-card border border-ink/10 bg-white p-8 text-center">
        <p class="font-sans text-[13px] uppercase tracking-[0.14em] text-ink-muted">
          {cancelled ? 'Venda cancelada' : 'Venda registrada'}
        </p>
        <p class="mt-2 font-display text-3xl">{brl(done.total_cents)}</p>
        <p class="mt-1 font-sans text-[13px] text-ink-muted">
          Pedido {orderLabel(done.order_number)} · {PAYMENT_METHOD_LABELS[done.method]}
        </p>

        {!cancelled && done.method === 'cash' && done.received_cents != null && (
          <div class="mt-4 rounded-card bg-bone-50 p-4 font-sans text-sm">
            <div class="flex justify-between">
              <span class="text-ink-muted">Recebido</span>
              <span>{brl(done.received_cents)}</span>
            </div>
            <div class="mt-1 flex justify-between font-semibold">
              <span>Troco</span>
              <span>{brl(Math.max(0, done.received_cents - done.total_cents))}</span>
            </div>
          </div>
        )}

        {cancelled && (
          <p class="mt-4 rounded-card bg-agua-wash p-3 font-sans text-[13px] text-agua-dark">
            Os itens voltaram ao estoque.
          </p>
        )}
        {error && <p class="mt-4 font-sans text-[13px] text-red-700">{error}</p>}

        <div class="mt-6 flex flex-col gap-2">
          <button type="button" class="btn-primary w-full" onClick={resetSale}>
            Nova venda
          </button>
          {!cancelled && (
            <button
              type="button"
              class="font-sans text-[13px] text-red-700 underline disabled:opacity-50"
              onClick={cancelSale}
              disabled={busy}
            >
              Cancelar esta venda
            </button>
          )}
          <a href="/admin/pedidos" class="font-sans text-[13px] text-ink-muted underline">
            Ver em Pedidos
          </a>
        </div>
      </div>
    );
  }

  // ---- tela de espera do Pix -------------------------------------------------
  if (pixWait) {
    return (
      <div class="mx-auto max-w-lg rounded-card border border-ink/10 bg-white p-8 text-center">
        <p class="font-sans text-[13px] uppercase tracking-[0.14em] text-ink-muted">Aguardando o Pix</p>
        <p class="mt-2 font-display text-3xl">{brl(pixWait.total_cents)}</p>
        <p class="mt-1 font-sans text-[13px] text-ink-muted">Pedido {orderLabel(pixWait.order_number)}</p>

        {pixWait.pix?.qrCodeBase64 && (
          <img
            src={`data:image/png;base64,${pixWait.pix.qrCodeBase64}`}
            alt="QR Code Pix"
            width={220}
            height={220}
            class="mx-auto mt-4 rounded-card border border-ink/10"
          />
        )}
        {pixWait.pix?.qrCode && (
          <div class="mt-4 text-left">
            <label class="label">Pix copia e cola</label>
            <textarea readOnly class="field font-mono text-[12px]" rows={3}>
              {pixWait.pix.qrCode}
            </textarea>
            <button
              type="button"
              class="btn-outline mt-2 w-full"
              onClick={() => navigator.clipboard?.writeText(pixWait.pix!.qrCode)}
            >
              Copiar código
            </button>
          </div>
        )}

        <p class="mt-4 font-sans text-[13px] text-ink-muted">
          Aguardando o cliente pagar… a confirmação é automática.
        </p>
        {error && <p class="mt-3 font-sans text-[13px] text-red-700">{error}</p>}

        <button
          type="button"
          class="mt-6 font-sans text-[13px] text-red-700 underline disabled:opacity-50"
          onClick={cancelPix}
          disabled={busy}
        >
          Cancelar e escolher outra forma de pagamento
        </button>
      </div>
    );
  }

  // ---- tela do caixa --------------------------------------------------------
  return (
    <div class="grid gap-6 lg:grid-cols-[1fr_20rem]">
      {session && (
        <CameraScanner
          onCode={sessionScan}
          onClose={closeSession}
          panel={
            <>
              <div class="flex items-baseline justify-between px-[16px] pt-[14px]">
                <p class="font-sans text-[15px] font-semibold text-ink">
                  Lidos agora{session.length ? ` (${session.reduce((s, l) => s + l.quantity, 0)})` : ''}
                </p>
                {session.length > 0 && <p class="font-sans text-[15px] font-semibold text-ink">{brl(session.reduce((s, l) => s + l.unit_price_cents * l.quantity, 0))}</p>}
              </div>
              {sessionMsg && <p class="px-[16px] pt-[6px] font-sans text-[13px] text-red-700">{sessionMsg}</p>}
              <div class="min-h-0 flex-1 overflow-y-auto px-[16px] py-[8px]">
                {session.length === 0 ? (
                  <p class="pt-[24px] text-center font-sans text-[14px] text-ink-muted">Aponte a câmera para o código de barras.</p>
                ) : (
                  <ul class="divide-y divide-ink/10">
                    {session.map((l) => (
                      <li key={l.product_id} class="flex items-center gap-[10px] py-[10px]">
                        <div class="min-w-0 flex-1">
                          <p class="truncate font-sans text-[15px] text-ink">{l.name}</p>
                          <p class="font-sans text-[12px] text-ink-muted">
                            {brl(l.unit_price_cents)} un.{l.quantity > l.stock && <span class="text-red-700"> · estoque: {l.stock}</span>}
                          </p>
                        </div>
                        <div class="flex shrink-0 items-center gap-[6px]">
                          <button
                            type="button"
                            class="grid h-[36px] w-[36px] place-items-center rounded-card border border-ink/20 text-ink"
                            aria-label={l.quantity === 1 ? 'Excluir' : 'Menos um'}
                            onClick={() => sessionQty(l.product_id, l.quantity - 1)}
                          >
                            {l.quantity === 1 ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                            ) : (
                              '−'
                            )}
                          </button>
                          <span class="w-[28px] text-center font-sans text-[15px] tabular-nums">{l.quantity}</span>
                          <button
                            type="button"
                            class="grid h-[36px] w-[36px] place-items-center rounded-card border border-ink/20 text-ink disabled:opacity-30"
                            aria-label="Mais um"
                            disabled={l.quantity + saleQty(l.product_id) >= l.stock}
                            onClick={() => sessionQty(l.product_id, l.quantity + 1)}
                          >
                            +
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div class="border-t border-ink/10 px-[16px] pb-[max(14px,env(safe-area-inset-bottom))] pt-[12px]">
                <button
                  type="button"
                  class="w-full rounded-full bg-ink py-[14px] font-sans text-[16px] font-semibold text-bone disabled:opacity-40"
                  disabled={session.length === 0}
                  onClick={confirmSession}
                >
                  Confirmar leitura
                </button>
              </div>
            </>
          }
        />
      )}
      {/* coluna esquerda: leitor + itens. min-w-0 nas duas colunas: sem ele a
          grade alargava a página no celular ao entrar o 1º produto (a tela
          ficava "com zoom" depois do leitor) */}
      <div class="min-w-0">
        <form onSubmit={submitScan} class="rounded-card border border-ink/10 bg-white p-4">
          <h2 class="mb-3 font-display text-lg">Pesquise para adicionar um produto à venda</h2>
          <label class="label" for="caixa-name">Nome</label>
          <span class="relative block">
            <svg class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              id="caixa-name"
              class="field pl-11"
              type="search"
              value={nameQuery}
              placeholder="Pesquise pelo nome do produto…"
              autocomplete="off"
              onInput={(e) => setNameQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                // Enter com um resultado só: já adiciona
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (matches.length === 1) addFromSearch(matches[0]!);
                }
              }}
            />
          </span>
          {nameQuery.trim() && (
            <ul class="mt-2 max-h-72 divide-y divide-ink/10 overflow-y-auto rounded-card border border-ink/10">
              {matches.length === 0 && <li class="p-3 font-sans text-[13px] text-ink-muted">Nenhum produto com esse nome.</li>}
              {matches.map((p) => {
                const block = stockBlock(p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      class="flex w-full items-center gap-3 p-2.5 text-left hover:bg-bone-50 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!!block}
                      onClick={() => addFromSearch(p)}
                    >
                      <span class="h-10 w-10 shrink-0 overflow-hidden rounded-card bg-bone-200">
                        {p.image && <img src={p.image} alt="" class="h-full w-full object-cover" />}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-sans text-sm text-ink">{p.name}</span>
                        <span class="block font-sans text-[12px] text-ink-muted">
                          {brl(p.price_cents)} · {p.stock <= 0 ? 'sem estoque' : block ? 'limite do estoque atingido' : `${p.stock - saleQty(p.id)} disponível`}
                        </span>
                      </span>
                      {!block && <span class="shrink-0 font-sans text-[13px] text-agua-dark">+ Adicionar</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <label class="label mt-4" for="caixa-scan">Código de barras</label>
          <div class="flex items-stretch gap-2">
            <input
              id="caixa-scan"
              ref={scanRef}
              class="field min-w-0 flex-1"
              value={scan}
              inputmode="numeric"
              autocomplete="off"
              placeholder="digitar código de barras manualmente"
              onInput={(e) => setScan((e.target as HTMLInputElement).value)}
            />
            <button type="submit" class={SCAN_BTN}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={CHECK_ICON_PATH} /></svg>
              Enviar
            </button>
          </div>
          <div class="mt-2 flex justify-end">
            <button
              type="button"
              class={SCAN_BTN}
              disabled={!hasCamera}
              title={hasCamera ? 'Ler o código com a câmera' : 'Nenhuma câmera encontrada neste aparelho'}
              onClick={() => {
                setScanMsg(null);
                setSessionMsg(null);
                setSession([]); // lista nova a cada abertura
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d={SCAN_ICON_PATH} /></svg>
              Abrir leitor
            </button>
          </div>
          {scanMsg && (
            <p
              class={`mt-2 font-sans text-[13px] ${
                scanMsg.tone === 'ok'
                  ? 'text-agua-dark'
                  : scanMsg.tone === 'warn'
                    ? 'text-amber-700'
                    : 'text-red-700'
              }`}
              aria-live="polite"
            >
              {scanMsg.text}
            </p>
          )}
        </form>

        <div class="mt-4 overflow-hidden rounded-card border border-ink/10 bg-white">
          {lines.length === 0 ? (
            <p class="p-8 text-center font-sans text-[14px] text-ink-muted">
              Nenhum item ainda. Comece bipando um produto.
            </p>
          ) : (
            <ul class="divide-y divide-ink/10">
              {lines.map((l) => {
                const over = l.quantity > l.stock;
                return (
                  <li key={l.product_id} class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:flex-nowrap">
                    <div class="h-12 w-12 shrink-0 overflow-hidden rounded-card bg-bone-200">
                      {l.image && <img src={l.image} alt="" class="h-full w-full object-cover" />}
                    </div>
                    <div class="min-w-0 flex-1 basis-[calc(100%-4.5rem)] sm:basis-auto">
                      <p class="truncate font-sans text-sm font-medium text-ink">{l.name}</p>
                      <p class="font-sans text-[12px] text-ink-muted">
                        {brl(l.unit_price_cents)} un.
                        {over && <span class="text-red-700"> · estoque: {l.stock}</span>}
                      </p>
                    </div>
                    <div class="ml-auto flex items-center gap-1 sm:ml-0">
                      <button
                        type="button"
                        class={`grid h-8 w-8 place-items-center rounded-card border text-ink hover:border-ink ${l.quantity === 1 ? 'border-red-300 text-red-700' : 'border-ink/20'}`}
                        aria-label={l.quantity === 1 ? 'Remover da venda' : 'Menos um'}
                        onClick={() => setQty(l.product_id, l.quantity - 1)}
                      >
                        {l.quantity === 1 ? TRASH_ICON : '−'}
                      </button>
                      <input
                        class="h-8 w-10 rounded-card border border-ink/20 text-center font-sans text-sm"
                        value={l.quantity}
                        inputmode="numeric"
                        onInput={(e) => {
                          const v = parseInt((e.target as HTMLInputElement).value, 10);
                          setQty(l.product_id, Number.isFinite(v) ? v : 1);
                        }}
                      />
                      <button
                        type="button"
                        class="grid h-8 w-8 place-items-center rounded-card border border-ink/20 text-ink hover:border-ink disabled:opacity-30 disabled:hover:border-ink/20"
                        aria-label="Mais um"
                        disabled={l.quantity >= l.stock}
                        title={l.quantity >= l.stock ? `Limite do estoque (${l.stock})` : undefined}
                        onClick={() => setQty(l.product_id, l.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                    <p class="w-20 shrink-0 text-right font-sans text-sm font-semibold">
                      {brl(l.unit_price_cents * l.quantity)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* coluna direita: fechamento */}
      <aside class="h-max min-w-0 rounded-card border border-ink/10 bg-white p-4 lg:sticky lg:top-6">
        <div class="flex items-baseline justify-between">
          <span class="font-sans text-[13px] text-ink-muted">
            {count} {count === 1 ? 'item' : 'itens'}
          </span>
        </div>
        <p class="mt-1 font-display text-3xl">{brl(total)}</p>

        <p class="label mt-5">Forma de pagamento</p>
        <div class="grid grid-cols-2 gap-2">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              class={`rounded-card border px-2 py-2 font-sans text-[13px] transition-colors ${
                method === m
                  ? 'border-ink bg-ink text-bone'
                  : 'border-ink/20 text-ink-soft hover:border-ink'
              }`}
            >
              {PAYMENT_METHOD_LABELS[m]}
            </button>
          ))}
        </div>

        {method === 'cash' && (
          <div class="mt-4">
            <label class="label" for="caixa-received">
              Valor recebido
            </label>
            <input
              id="caixa-received"
              class="field"
              value={received}
              inputmode="decimal"
              placeholder="0,00"
              onInput={(e) => setReceived((e.target as HTMLInputElement).value)}
            />
            {changeCents != null && (
              <p
                class={`mt-2 flex justify-between font-sans text-sm ${
                  changeCents < 0 ? 'text-red-700' : 'text-ink'
                }`}
              >
                <span>{changeCents < 0 ? 'Falta' : 'Troco'}</span>
                <span class="font-semibold">{brl(Math.abs(changeCents))}</span>
              </p>
            )}
          </div>
        )}

        {overStock && (
          <p class="mt-4 rounded-card bg-amber-50 p-2 font-sans text-[12px] text-amber-800">
            Um item está acima do estoque registrado — a venda pode ser recusada.
          </p>
        )}
        {error && <p class="mt-4 font-sans text-[13px] text-red-700">{error}</p>}

        <button
          type="button"
          class="btn-primary mt-5 w-full disabled:opacity-50"
          onClick={finalize}
          disabled={busy || lines.length === 0}
        >
          {busy ? 'Registrando…' : 'Finalizar venda'}
        </button>
        {lines.length > 0 && (
          <button
            type="button"
            class="mt-2 w-full font-sans text-[13px] text-ink-muted underline"
            onClick={resetSale}
          >
            Limpar
          </button>
        )}
      </aside>
    </div>
  );
}
