import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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

export default function CaixaFlow() {
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [pixWait, setPixWait] = useState<PixWait | null>(null);

  const scanRef = useRef<HTMLInputElement>(null);
  const focusScanner = () => window.setTimeout(() => scanRef.current?.focus(), 0);

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
    const code = scan.trim();
    if (!code || busy) return;
    setScanMsg(null);
    try {
      const res = await fetch(`/api/admin/products/by-barcode?code=${encodeURIComponent(code)}`);
      if (res.status === 404) {
        setScanMsg({ tone: 'err', text: `Código ${code} não está cadastrado.` });
        setScan('');
        return;
      }
      if (!res.ok) {
        setScanMsg({ tone: 'err', text: 'Erro ao buscar o produto. Tente de novo.' });
        return;
      }
      const p = (await res.json()) as ScanResult;
      setLines((cur) => {
        const i = cur.findIndex((l) => l.product_id === p.id);
        if (i >= 0) {
          const next = [...cur];
          next[i] = { ...next[i], quantity: next[i].quantity + 1 };
          return next;
        }
        return [
          ...cur,
          {
            product_id: p.id,
            name: p.name,
            unit_price_cents: p.price_cents,
            quantity: 1,
            stock: p.stock,
            image: p.image,
          },
        ];
      });
      setScanMsg({
        tone: p.stock <= 0 ? 'warn' : 'ok',
        text: p.stock <= 0 ? `${p.name} — sem estoque registrado` : `${p.name} adicionado`,
      });
      setScan('');
    } catch {
      setScanMsg({ tone: 'err', text: 'Sem conexão com o servidor.' });
    } finally {
      focusScanner();
    }
  }

  const setQty = (id: string, qty: number) =>
    setLines((cur) =>
      qty <= 0
        ? cur.filter((l) => l.product_id !== id)
        : cur.map((l) => (l.product_id === id ? { ...l, quantity: qty } : l)),
    );
  const removeLine = (id: string) => setLines((cur) => cur.filter((l) => l.product_id !== id));

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
      {/* coluna esquerda: leitor + itens */}
      <div>
        <form onSubmit={submitScan} class="rounded-card border border-ink/10 bg-white p-4">
          <label class="label" for="caixa-scan">
            Passar produto no leitor
          </label>
          <input
            id="caixa-scan"
            ref={scanRef}
            class="field text-lg"
            value={scan}
            inputmode="numeric"
            autocomplete="off"
            placeholder="bipe o código de barras ou digite e aperte Enter"
            onInput={(e) => setScan((e.target as HTMLInputElement).value)}
          />
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
                  <li key={l.product_id} class="flex items-center gap-3 p-3">
                    <div class="h-12 w-12 shrink-0 overflow-hidden rounded-card bg-bone-200">
                      {l.image && <img src={l.image} alt="" class="h-full w-full object-cover" />}
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-sans text-sm font-medium text-ink">{l.name}</p>
                      <p class="font-sans text-[12px] text-ink-muted">
                        {brl(l.unit_price_cents)} un.
                        {over && <span class="text-red-700"> · estoque: {l.stock}</span>}
                      </p>
                    </div>
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        class="grid h-7 w-7 place-items-center rounded-card border border-ink/20 text-ink hover:border-ink"
                        aria-label="Menos um"
                        onClick={() => setQty(l.product_id, l.quantity - 1)}
                      >
                        −
                      </button>
                      <input
                        class="h-7 w-10 rounded-card border border-ink/20 text-center font-sans text-sm"
                        value={l.quantity}
                        inputmode="numeric"
                        onInput={(e) => {
                          const v = parseInt((e.target as HTMLInputElement).value, 10);
                          setQty(l.product_id, Number.isFinite(v) ? v : 1);
                        }}
                      />
                      <button
                        type="button"
                        class="grid h-7 w-7 place-items-center rounded-card border border-ink/20 text-ink hover:border-ink"
                        aria-label="Mais um"
                        onClick={() => setQty(l.product_id, l.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                    <p class="w-20 shrink-0 text-right font-sans text-sm font-semibold">
                      {brl(l.unit_price_cents * l.quantity)}
                    </p>
                    <button
                      type="button"
                      class="shrink-0 font-sans text-[12px] text-ink-muted underline hover:text-red-700"
                      onClick={() => removeLine(l.product_id)}
                    >
                      remover
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* coluna direita: fechamento */}
      <aside class="h-max rounded-card border border-ink/10 bg-white p-4 lg:sticky lg:top-6">
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
