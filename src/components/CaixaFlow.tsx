import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import CameraScanner from './CameraScanner';
import { SCAN_BTN, SCAN_ICON_PATH, useHasCamera } from './CameraScanButton';
import { brl, maskMoney, moneyToCents, orderLabel } from '../lib/format';
import { CANCEL_REASONS_CAIXA, PAYMENT_METHOD_LABELS, type PaymentMethod, type PaymentPart } from '../lib/types';
import { SINGLE_METHODS, SPLIT_METHODS, splitChange, splitError } from '../lib/payments';
import { confirmDialog } from '../lib/confirm-dialog';

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
  barcode?: string | null;
}

interface Done {
  order_number: string;
  total_cents: number;
  received_cents: number | null;
  method: PaymentMethod;
  payments?: PaymentPart[];
}

interface PixWait {
  order_id: string;
  order_number: string;
  total_cents: number;
  /** pagamento combinado: só esta parte vai no Pix */
  pix_cents?: number;
  payments?: PaymentPart[];
  pix: { qrCode: string; qrCodeBase64: string; ticketUrl: string } | null;
  /** combinado com Pix: um QR por parte, em sequência (`paid` = Pix já pagos) */
  split?: { index: number; count: number; paid: string[]; current: string };
}

/** Resposta do servidor para o Pix em partes (action pix_split). */
interface SplitStep {
  error?: string;
  state?: 'charge' | 'waiting' | 'done' | 'failed';
  order_id?: string;
  order_number?: string;
  total_cents?: number;
  index?: number;
  count?: number;
  amount_cents?: number;
  payment_id?: string | null;
  pix?: PixWait['pix'];
}

const METHODS: PaymentMethod[] = ['cash', 'pix', 'debit_card', 'credit_card'];

/** minúsculas e sem acento, pra busca por nome */
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const TRASH_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);

export default function CaixaFlow({ products = [], canCancel = true }: { products?: ScanResult[]; canCancel?: boolean }) {
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
  // pagamento combinado: cada forma com o seu valor (mascarado em R$)
  const [split, setSplit] = useState(false);
  // method '' = linha nova, ainda em "Selecionar"
  const [parts, setParts] = useState<{ method: PaymentPart['method'] | ''; amount: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [cancelled, setCancelled] = useState(false);
  // cancelar logo após a venda: motivo obrigatório ("Outro" pede detalhe)
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMotivo, setCancelMotivo] = useState('');
  const [cancelDetalhe, setCancelDetalhe] = useState('');
  const [cancelRestock, setCancelRestock] = useState(true);
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

  /** Aplica um passo do Pix em partes: próximo QR, venda fechada ou falha. */
  function applySplitStep(data: SplitStep, paid: string[], payments: PaymentPart[] | undefined) {
    if (data.state === 'charge' && data.order_number) {
      setPixWait({
        order_id: data.order_id ?? '',
        order_number: data.order_number,
        total_cents: data.total_cents ?? total,
        pix_cents: data.amount_cents,
        payments,
        pix: data.pix ?? null,
        split: { index: data.index ?? 0, count: data.count ?? 1, paid, current: data.payment_id ?? '' },
      });
    } else if (data.state === 'done' && data.order_number) {
      setDone({ order_number: data.order_number, total_cents: data.total_cents ?? total, received_cents: null, method: 'misto', payments });
      setPixWait(null);
    } else if (data.state === 'failed') {
      setError('O Pix não foi confirmado. Tente de novo.');
      setPixWait(null);
    } else if (data.error) {
      setError(data.error);
    }
  }

  // ---- Polling do Pix: enquanto aguarda, checa a cada 3s se já confirmou ----
  useEffect(() => {
    if (!pixWait) return;
    const id = window.setInterval(async () => {
      try {
        if (pixWait.split) {
          // combinado: o servidor confere este Pix no Mercado Pago e cobra o próximo
          const ids = [...pixWait.split.paid, pixWait.split.current];
          const res = await fetch('/api/admin/caixa', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'pix_split', order_number: pixWait.order_number, payment_ids: ids }),
          });
          const data = (await res.json().catch(() => ({}))) as SplitStep;
          if (data.state !== 'waiting') window.clearInterval(id);
          applySplitStep(data, ids, pixWait.payments);
          return;
        }
        const res = await fetch(`/api/payments/status?id=${pixWait.order_id}`);
        const data = (await res.json().catch(() => ({}))) as { status?: string };
        if (data.status === 'paid') {
          window.clearInterval(id);
          setDone({
            order_number: pixWait.order_number,
            total_cents: pixWait.total_cents,
            received_cents: null,
            method: pixWait.payments ? 'misto' : 'pix',
            payments: pixWait.payments,
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
  const receivedCents = method === 'cash' && received ? moneyToCents(received) : null;
  const overStock = lines.some((l) => l.quantity > l.stock);
  const splitParts = parts.map((p) => ({ method: p.method, amount_cents: moneyToCents(p.amount) })) as PaymentPart[];
  const splitErr = split ? splitError(splitParts, total) : null;
  // saldo das duas telas (uma forma em dinheiro ou combinado): falta receber ou troco
  const paidCents = split ? splitParts.reduce((s, p) => s + p.amount_cents, 0) : (receivedCents ?? 0);
  const due = total - paidCents;
  const cardOver = split && splitParts.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.amount_cents, 0) > total;
  // dinheiro sozinho: só fecha com o valor recebido cobrindo o total
  const cashErr =
    !split && method === 'cash' && lines.length
      ? receivedCents == null
        ? 'Informe o valor recebido.'
        : receivedCents < total
          ? 'Valor recebido menor que o total.'
          : null
      : null;

  function toggleSplit() {
    setSplit((on) => !on);
    setParts([{ method: '', amount: '' }]);
    setError(null);
  }
  const setPart = (i: number, patch: Partial<(typeof parts)[number]>) =>
    setParts((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function submitScan(e: Event) {
    e.preventDefault();
    const code = scan.trim();
    // código igual a um do catálogo: adiciona direto; senão pergunta ao servidor
    const exact = products.find((p) => p.barcode && p.barcode === code);
    if (exact) addFromSearch(exact, () => setScan(''));
    else await addByCode(code);
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

  // busca por código: trecho do código de barras enquanto digita
  const codeMatches = useMemo(() => {
    const digits = scan.replace(/\D/g, '');
    if (!digits) return [];
    return products.filter((p) => p.barcode?.includes(digits)).slice(0, 8);
  }, [scan, products]);

  function addFromSearch(p: ScanResult, clear = () => setNameQuery('')) {
    const block = stockBlock(p);
    if (block) return setScanMsg({ tone: 'err', text: block });
    setLines((cur) => mergeLines(cur, [toLine(p)]));
    setScanMsg({ tone: 'ok', text: `${p.name} adicionado` });
    clear();
  }

  /** Soma `add` em `cur` (mesmo produto → soma quantidade, nunca acima do estoque). */
  const mergeLines = (cur: Line[], add: Line[]) => {
    const next = [...cur];
    for (const l of add) {
      const i = next.findIndex((x) => x.product_id === l.product_id);
      if (i >= 0) next[i] = { ...next[i]!, quantity: Math.min(next[i]!.quantity + l.quantity, l.stock) };
      else next.push({ ...l, quantity: Math.min(l.quantity, l.stock) });
    }
    return next;
  };

  /** Lista de sugestões (nome ou código) com "+ Adicionar". */
  const suggestions = (list: ScanResult[], empty: string, clear: () => void) => (
    <ul class="mt-2 max-h-72 divide-y divide-ink/10 overflow-y-auto rounded-card border border-ink/10">
      {list.length === 0 && <li class="p-3 font-sans text-[13px] text-ink-muted">{empty}</li>}
      {list.map((p) => {
        const block = stockBlock(p);
        return (
          <li key={p.id}>
            <button
              type="button"
              class="flex w-full items-center gap-3 p-2.5 text-left hover:bg-bone-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!!block}
              onClick={() => addFromSearch(p, clear)}
            >
              <span class="h-10 w-10 shrink-0 overflow-hidden rounded-card bg-bone-200">
                {p.image && <img src={p.image} alt="" class="h-full w-full object-cover" />}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-sans text-sm text-ink">{p.name}</span>
                <span class="block truncate font-sans text-[12px] text-ink-muted">
                  {p.barcode && `${p.barcode} · `}
                  {brl(p.price_cents)} · {p.stock <= 0 ? 'sem estoque' : block ? 'limite do estoque atingido' : `${p.stock - saleQty(p.id)} disponível`}
                </span>
              </span>
              {!block && <span class="shrink-0 font-sans text-[13px] text-agua-dark">+ Adicionar</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );

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
    setSplit(false);
    setParts([]);
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
    if (!lines.length || busy || splitErr || cashErr) return;
    // combinado com uma linha só vira pagamento simples
    if (split && parts.length === 1) {
      const only = splitParts[0]!;
      return finalizeWith(false, only.method, only.method === 'cash' ? only.amount_cents : null);
    }
    return finalizeWith(split, method, receivedCents);
  }

  async function cancelPurchase() {
    const ok = await confirmDialog({
      title: 'Cancelar compra?',
      message: 'Os itens e os valores informados saem do caixa.',
      confirmLabel: 'Cancelar compra',
      cancelLabel: 'Voltar',
    });
    if (ok) resetSale();
  }

  async function finalizeWith(split: boolean, method: PaymentMethod, receivedCents: number | null) {
    setBusy(true);
    setError(null);
    const payments = split ? splitParts : undefined;
    try {
      if (split ? payments!.some((p) => p.method === 'pix') : method === 'pix') {
        const res = await fetch('/api/admin/caixa', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'pix_charge',
            items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
            payments,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as SplitStep & { status?: string };
        if (payments && res.ok) return applySplitStep(data, [], payments);
        if (!res.ok || data.error || !data.order_number) {
          setError(data.error || 'Não foi possível gerar o Pix.');
          return;
        }
        if (data.status === 'approved') {
          setDone({
            order_number: data.order_number,
            total_cents: data.total_cents ?? total,
            received_cents: null,
            method: payments ? 'misto' : 'pix',
            payments,
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
          method: split ? 'misto' : method,
          payments,
          received_cents: receivedCents,
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
        method: split ? 'misto' : method,
        payments,
      });
    } catch {
      setError('Sem conexão com o servidor.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelPix() {
    if (!pixWait || busy) return;
    if (
      pixWait.split?.paid.length &&
      !(await confirmDialog({
        title: 'Cancelar a venda?',
        message: 'Já entrou Pix nesta venda. Ao cancelar, devolva esse valor pelo Mercado Pago.',
        confirmLabel: 'Cancelar venda',
        cancelLabel: 'Voltar',
      }))
    )
      return;
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
    if (!cancelMotivo || (cancelMotivo === 'Outro' && cancelDetalhe.trim().length < 3)) {
      setError(cancelMotivo ? 'Descreva o motivo.' : 'Escolha o motivo do cancelamento.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/caixa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', order_number: done.order_number, motivo: cancelMotivo, detalhe: cancelDetalhe, restock: cancelRestock }),
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

        {!cancelled && done.payments && (
          <div class="mt-4 space-y-1 rounded-card bg-bone-50 p-4 font-sans text-sm">
            {done.payments.map((p, i) => (
              <div key={i} class="flex justify-between">
                <span class="text-ink-muted">{PAYMENT_METHOD_LABELS[p.method]}</span>
                <span>{brl(p.amount_cents)}</span>
              </div>
            ))}
            <div class="flex justify-between font-semibold">
              <span>Troco</span>
              <span>{brl(splitChange(done.payments, done.total_cents))}</span>
            </div>
          </div>
        )}

        {cancelled && (
          <p class="mt-4 rounded-card bg-agua-wash p-3 font-sans text-[13px] text-agua-dark">
            {cancelRestock ? 'Os itens voltaram ao estoque' : 'Os itens não voltaram ao estoque'} e o valor saiu do caixa do dia. Devolva o dinheiro ao cliente.
          </p>
        )}
        {error && <p class="mt-4 font-sans text-[13px] text-red-700">{error}</p>}

        <div class="mt-6 flex flex-col gap-2">
          <button type="button" class="btn-primary w-full" onClick={resetSale}>
            Nova venda
          </button>
          {!cancelled && canCancel && !cancelOpen && (
            <button type="button" class="font-sans text-[13px] text-red-700 underline" onClick={() => setCancelOpen(true)}>
              Cancelar esta venda
            </button>
          )}
          {!cancelled && canCancel && cancelOpen && (
            <div class="mt-2 space-y-2 rounded-card border border-red-200 p-3 text-left font-sans text-sm">
              <label class="block">
                <span class="label">Motivo do cancelamento <span class="text-red-600">*</span></span>
                <select class="field" value={cancelMotivo} onChange={(e) => setCancelMotivo((e.target as HTMLSelectElement).value)}>
                  <option value="" disabled>Selecione o motivo</option>
                  {CANCEL_REASONS_CAIXA.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              {cancelMotivo === 'Outro' && (
                <label class="block">
                  <span class="label">Detalhes <span class="text-red-600">*</span></span>
                  <textarea class="field" rows={2} maxLength={400} value={cancelDetalhe} onInput={(e) => setCancelDetalhe((e.target as HTMLTextAreaElement).value)} />
                </label>
              )}
              <label class="flex items-start gap-2 text-[13px] text-ink-soft">
                <input type="checkbox" class="mt-0.5" checked={cancelRestock} onChange={(e) => setCancelRestock((e.target as HTMLInputElement).checked)} />
                Devolver os itens ao estoque (desmarque se o produto está danificado)
              </label>
              <div class="flex gap-2">
                <button type="button" class="flex-1 rounded-card border border-ink/20 px-3 py-2 text-[13px]" onClick={() => setCancelOpen(false)}>Voltar</button>
                <button type="button" class="flex-1 rounded-card bg-red-700 px-3 py-2 text-[13px] text-white disabled:opacity-50" onClick={cancelSale} disabled={busy}>Cancelar venda</button>
              </div>
            </div>
          )}
          <a href="/admin/pedidos" class="font-sans text-[13px] text-ink-muted underline">
            Ver em Compras
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
        <p class="mt-2 font-display text-3xl">{brl(pixWait.pix_cents ?? pixWait.total_cents)}</p>
        <p class="mt-1 font-sans text-[13px] text-ink-muted">
          Pedido {orderLabel(pixWait.order_number)}
          {pixWait.split && pixWait.split.count > 1 && ` · Pix ${pixWait.split.index + 1} de ${pixWait.split.count}`}
          {pixWait.pix_cents != null && ` · parte do total de ${brl(pixWait.total_cents)}`}
        </p>

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

  /** "Falta receber" (alerta) ou "Troco" (verde); nada quando fecha exato. */
  const balance = (amount: number) =>
    due > 0 ? (
      <p class="flex justify-between rounded-card bg-red-50 px-3 py-2 font-sans text-sm font-semibold text-red-700" role="status">
        <span>Falta receber:</span>
        <span>{brl(amount)}</span>
      </p>
    ) : due < 0 ? (
      <p class="flex justify-between rounded-card bg-green-50 px-3 py-2 font-sans text-sm font-semibold text-green-700" role="status">
        <span>Troco:</span>
        <span>{brl(amount)}</span>
      </p>
    ) : null;

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
          <h2 class="mb-3 font-display text-lg">Adicionar produto</h2>
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
          {nameQuery.trim() && suggestions(matches, 'Nenhum produto com esse nome.', () => setNameQuery(''))}

          <label class="label mt-4" for="caixa-scan">Código de barras</label>
          {/* Enter (ou leitor USB, que digita e manda Enter) adiciona o código exato */}
          <input
            id="caixa-scan"
            ref={scanRef}
            class="field"
            value={scan}
            inputmode="numeric"
            autocomplete="off"
            placeholder="digitar código de barras manualmente"
            onInput={(e) => setScan((e.target as HTMLInputElement).value)}
          />
          {scan.trim() && suggestions(codeMatches, 'Nenhum produto com esse código. Enter busca o código completo.', () => setScan(''))}
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
                          const el = e.target as HTMLInputElement;
                          const v = parseInt(el.value, 10);
                          const q = Math.max(1, Math.min(Number.isFinite(v) ? v : 1, l.stock));
                          // o estado pode não mudar (já no limite): corrige o que aparece no campo
                          if (el.value !== '') el.value = String(q);
                          setQty(l.product_id, q);
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

        <div class="mt-5 flex items-baseline justify-between">
          <p class="label">Forma de pagamento</p>
          <button type="button" class="font-sans text-[12px] text-agua-dark underline" onClick={toggleSplit}>
            {split ? 'Desfazer' : 'Combinar'}
          </button>
        </div>
        {!split && (
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
        )}

        {split && (
          <div class="space-y-2">
            {parts.map((p, i) => (
              <div key={i} class="flex items-center gap-2">
                <select
                  class="field min-w-0 flex-1 py-2 text-[13px]"
                  aria-label="Forma de pagamento"
                  value={p.method}
                  onChange={(e) => setPart(i, { method: (e.target as HTMLSelectElement).value as PaymentPart['method'] })}
                >
                  {p.method === '' && <option value="" disabled>Selecionar</option>}
                  {SPLIT_METHODS.filter((m) => m === p.method || !SINGLE_METHODS.includes(m) || !parts.some((o) => o.method === m)).map((m) => (
                    <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                  ))}
                </select>
                <input
                  class="field w-28 py-2 text-right text-[13px]"
                  aria-label={p.method ? `Valor em ${PAYMENT_METHOD_LABELS[p.method]}` : 'Valor'}
                  value={p.amount}
                  inputmode="numeric"
                  placeholder="0,00"
                  onInput={(e) => setPart(i, { amount: maskMoney((e.target as HTMLInputElement).value) })}
                />
                {/* última linha não sai: a lixeira só zera o valor */}
                <button
                  type="button"
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-card border border-red-300 text-red-700"
                  aria-label={parts.length > 1 ? 'Remover forma' : 'Zerar valor'}
                  onClick={() =>
                    parts.length > 1 ? setParts((cur) => cur.filter((_, j) => j !== i)) : setPart(i, { amount: '' })
                  }
                >
                  {TRASH_ICON}
                </button>
              </div>
            ))}
            <button
              type="button"
              class="font-sans text-[12px] text-agua-dark underline"
              onClick={() => setParts((cur) => [...cur, { method: '', amount: '' }])}
            >
              + Adicionar
            </button>
            {parts.some((p) => !p.method) && (
              <p class="font-sans text-[13px] text-ink-muted">Selecione a forma de pagamento.</p>
            )}
            {parts.some((p) => !moneyToCents(p.amount)) && (
              <p class="font-sans text-[13px] text-ink-muted">Informe o valor recebido por cada forma de pagamento.</p>
            )}
            {cardOver && <p class="font-sans text-[13px] text-red-700">{splitError(splitParts, total)}</p>}
            {lines.length > 0 && !cardOver && balance(due < 0 ? splitChange(splitParts, total) : due)}
            {parts.some((p) => p.method === 'pix') && (
              <p class="font-sans text-[12px] text-ink-muted">Cada Pix gera um QR Code só com o valor dele, um depois do outro; a venda fecha quando todos forem pagos.</p>
            )}
          </div>
        )}

        {!split && method === 'cash' && (
          <div class="mt-4">
            <label class="label" for="caixa-received">
              Valor recebido
            </label>
            <span class="relative block">
              <span class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-sans text-sm text-ink-muted">R$</span>
              <input
                id="caixa-received"
                class="field pl-11"
                value={received}
                inputmode="numeric"
                placeholder="0,00"
                onInput={(e) => setReceived(maskMoney((e.target as HTMLInputElement).value))}
              />
            </span>
            {lines.length > 0 && <div class="mt-2">{balance(Math.abs(due))}</div>}
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
          disabled={busy || lines.length === 0 || !!splitErr || !!cashErr}
          title={splitErr ?? cashErr ?? undefined}
        >
          {busy ? 'Registrando…' : 'Finalizar venda'}
        </button>
        {lines.length > 0 && (
          <button
            type="button"
            class="mt-2 w-full font-sans text-[13px] text-red-700 underline"
            onClick={cancelPurchase}
          >
            Cancelar compra
          </button>
        )}
      </aside>
    </div>
  );
}
