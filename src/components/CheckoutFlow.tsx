import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '@nanostores/preact';
import { cartLines, cartSubtotalCents, clearCart } from '../lib/cart';
import {
  brl,
  formatCep,
  formatCpf,
  formatPhone,
  isValidCep,
  isValidCpf,
  isValidEmail,
  isValidPhone,
  onlyDigits,
  orderLabel,
} from '../lib/format';
import { productImage } from '../lib/images';
import type { Address } from '../lib/types';

const MP_PUBLIC_KEY = import.meta.env.PUBLIC_MP_PUBLIC_KEY as string | undefined;

interface Props {
  isLoggedIn?: boolean;
  userEmail?: string;
  initialProfile?: { full_name: string; phone: string; cpf: string } | null;
  savedAddresses?: Address[];
}

interface Form {
  name: string;
  email: string;
  phone: string;
  cpf: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

const emptyForm: Form = {
  name: '', email: '', phone: '', cpf: '', cep: '',
  street: '', number: '', complement: '', district: '', city: '', state: '',
};

type Step = 'form' | 'payment' | 'pix';

export default function CheckoutFlow({
  isLoggedIn = false,
  userEmail = '',
  initialProfile = null,
  savedAddresses = [],
}: Props) {
  const lines = useStore(cartLines);
  const subtotal = useStore(cartSubtotalCents);

  const [form, setForm] = useState<Form>({
    ...emptyForm,
    name: initialProfile?.full_name ?? '',
    email: userEmail,
    phone: formatPhone(initialProfile?.phone ?? ''),
    cpf: formatCpf(initialProfile?.cpf ?? ''),
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [selectedAddressId, setSelectedAddressId] = useState<string>(
    savedAddresses.find((a) => a.is_default)?.id ?? savedAddresses[0]?.id ?? 'new',
  );
  const [saveAddress, setSaveAddress] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [shipping, setShipping] = useState<{ cents: number; label: string } | null>(null);
  const [cepLoading, setCepLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState<{ id: string; order_number: string; total_cents: number } | null>(null);
  const [pix, setPix] = useState<{ qrCode: string; qrCodeBase64: string; ticketUrl: string } | null>(null);
  const brickMounted = useRef(false);

  const total = subtotal + (shipping?.cents ?? 0);

  function set<K extends keyof Form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof Form, string>> = {};
    if (form.name.trim().length < 3 || !/\s/.test(form.name.trim()))
      e.name = 'Informe nome e sobrenome.';
    if (!isValidEmail(form.email)) e.email = 'E-mail inválido.';
    if (!isValidPhone(form.phone)) e.phone = 'Telefone com DDD (10 ou 11 dígitos).';
    if (!isValidCpf(form.cpf)) e.cpf = 'CPF inválido.';
    if (!isValidCep(form.cep)) e.cep = 'CEP inválido.';
    if (!form.street.trim()) e.street = 'Obrigatório.';
    if (!form.number.trim()) e.number = 'Obrigatório (use "s/n").';
    if (!form.district.trim()) e.district = 'Obrigatório.';
    if (!form.city.trim()) e.city = 'Obrigatório.';
    if (!/^[A-Za-z]{2}$/.test(form.state.trim())) e.state = 'UF.';
    setFieldErrors(e);
    const firstKey = Object.keys(e)[0];
    if (firstKey) {
      const el = document.getElementById(firstKey === 'cep' ? 'cep' : `co-${firstKey}`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (el as HTMLInputElement | null)?.focus({ preventScroll: true });
    }
    return Object.keys(e).length === 0;
  }

  // aplica um endereço salvo ao formulário + calcula o frete
  function applySavedAddress(id: string) {
    setSelectedAddressId(id);
    if (id === 'new') return;
    const addr = savedAddresses.find((a) => a.id === id);
    if (!addr) return;
    setForm((f) => ({
      ...f,
      cep: formatCep(addr.cep),
      street: addr.street,
      number: addr.number,
      complement: addr.complement,
      district: addr.district,
      city: addr.city,
      state: addr.state,
    }));
    lookupCep(addr.cep);
  }

  // se há endereço padrão, já aplica ao montar
  useEffect(() => {
    if (savedAddresses.length && selectedAddressId !== 'new') {
      applySavedAddress(selectedAddressId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- CEP autofill + frete ----
  async function lookupCep(rawCep: string) {
    const cep = onlyDigits(rawCep);
    if (cep.length !== 8) return;
    setCepLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cep/${cep}?subtotal=${subtotal}`);
      const data = await res.json();
      if (data.address) {
        setForm((f) => ({
          ...f,
          street: data.address.street || f.street,
          district: data.address.district || f.district,
          city: data.address.city || f.city,
          state: data.address.state || f.state,
        }));
      }
      if (data.shipping) setShipping({ cents: data.shipping.cents, label: data.shipping.label });
    } catch {
      setError('Não foi possível consultar o CEP. Preencha o endereço manualmente.');
    } finally {
      setCepLoading(false);
    }
  }

  // ---- Etapa 1 -> cria pedido ----
  async function goToPayment(e: Event) {
    e.preventDefault();
    setError(null);
    if (!validate()) {
      setError('Confira os campos destacados antes de continuar.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customer: { name: form.name, email: form.email, phone: form.phone, cpf: form.cpf },
          shipping: {
            cep: form.cep, street: form.street, number: form.number, complement: form.complement,
            district: form.district, city: form.city, state: form.state,
          },
          items: lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar o pedido.');
      setOrder({ id: data.id, order_number: data.order_number, total_cents: data.total_cents });
      setShipping({ cents: data.shipping_cents, label: data.shipping_label });
      setStep('payment');

      if (isLoggedIn && saveAddress && selectedAddressId === 'new') {
        fetch('/api/account/addresses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label: 'Endereço', cep: form.cep, street: form.street, number: form.number,
            complement: form.complement, district: form.district, city: form.city, state: form.state,
            is_default: savedAddresses.length === 0,
          }),
        }).catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar o pedido.');
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Pagamento simulado (sem chaves MP) ----
  async function paySimulated() {
    if (!order) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order_id: order.id, formData: { payment_method_id: 'simulado' } }),
      });
      const data = await res.json();
      if (data.status === 'approved') {
        clearCart();
        window.location.href = data.redirect;
        return;
      }
      throw new Error(data.error || 'Pagamento não aprovado.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro no pagamento.');
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Mercado Pago Payment Brick ----
  useEffect(() => {
    if (step !== 'payment' || !order || !MP_PUBLIC_KEY || brickMounted.current) return;
    brickMounted.current = true;

    async function mountBrick() {
      await loadMpSdk();
      // @ts-expect-error SDK global
      const mp = new window.MercadoPago(MP_PUBLIC_KEY, { locale: 'pt-BR' });
      const bricks = mp.bricks();
      await bricks.create('payment', 'mp-brick-container', {
        initialization: {
          amount: order!.total_cents / 100,
          payer: { email: form.email },
        },
        customization: {
          visual: { style: { theme: 'flat' } },
          paymentMethods: {
            creditCard: 'all',
            debitCard: 'all',
            bankTransfer: 'all',
            maxInstallments: 6,
          },
        },
        callbacks: {
          onReady: () => {},
          onError: (err: unknown) => {
            console.error(err);
            setError('Erro ao carregar o formulário de pagamento.');
          },
          onSubmit: async ({ formData }: { formData: Record<string, unknown> }) => {
            setError(null);
            const res = await fetch('/api/payments', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ order_id: order!.id, formData }),
            });
            const data = await res.json();
            if (data.status === 'approved') {
              clearCart();
              window.location.href = data.redirect;
            } else if (data.status === 'pending' && data.pix) {
              setPix(data.pix);
              setStep('pix');
            } else if (data.status === 'pending') {
              setError('Pagamento em análise. Você recebe a confirmação por e-mail.');
            } else {
              setError(data.detail || data.error || 'Pagamento recusado. Tente outro método.');
            }
          },
        },
      });
    }

    mountBrick().catch((err) => {
      console.error(err);
      setError('Não foi possível iniciar o pagamento.');
    });
  }, [step, order]);

  // ---- Polling do Pix ----
  useEffect(() => {
    if (step !== 'pix' || !order) return;
    const id = window.setInterval(async () => {
      const res = await fetch(`/api/payments/status?id=${order.id}`);
      const data = await res.json();
      if (data.status === 'paid' && data.redirect) {
        clearCart();
        window.location.href = data.redirect;
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [step, order]);

  const summary = useMemo(
    () => (
      <aside class="rounded-card border border-ink/10 bg-white/50 p-6">
        <h2 class="font-display text-lg">Resumo</h2>
        <ul class="mt-4 space-y-3">
          {lines.map((l) => (
            <li key={l.productId} class="flex gap-3">
              <img src={productImage(l.image, 120)} alt="" width={44} height={55} class="h-14 w-11 rounded-card object-cover" />
              <div class="flex-1 text-[13px]">
                <p class="text-ink">{l.name}</p>
                <p class="text-ink-muted">Qtd. {l.quantity}</p>
              </div>
              <span class="text-[13px] text-ink">{brl(l.priceCents * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <dl class="mt-5 space-y-1.5 border-t border-ink/10 pt-4 text-[14px]">
          <div class="flex justify-between text-ink-soft"><dt>Subtotal</dt><dd>{brl(subtotal)}</dd></div>
          <div class="flex justify-between text-ink-soft">
            <dt>Frete{shipping ? ` · ${shipping.label}` : ''}</dt>
            <dd>{shipping ? (shipping.cents === 0 ? 'Grátis' : brl(shipping.cents)) : '—'}</dd>
          </div>
          <div class="flex justify-between border-t border-ink/10 pt-2 font-display text-lg text-ink">
            <dt>Total</dt><dd>{brl(total)}</dd>
          </div>
        </dl>
      </aside>
    ),
    [lines, subtotal, shipping, total],
  );

  if (lines.length === 0 && step === 'form') {
    return (
      <div class="py-20 text-center">
        <p class="prose-iarah mx-auto">Sua sacola está vazia.</p>
        <a href="/loja" class="btn-primary mt-6">Ir para a loja</a>
      </div>
    );
  }

  return (
    <div class="grid gap-10 lg:grid-cols-[1.4fr_1fr] lg:gap-16">
      <div>
        {error && (
          <p class="mb-6 rounded-card border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
        )}

        {step === 'form' && (
          <form onSubmit={goToPayment} noValidate class="space-y-8">
            {!isLoggedIn && (
              <p class="rounded-card border border-ink/10 bg-white/50 px-4 py-3 font-sans text-[13px] text-ink-soft">
                Já tem conta?{' '}
                <a href="/entrar?next=/checkout" class="text-agua-dark underline">Entrar</a>{' '}
                para usar seus dados e endereços salvos.
              </p>
            )}

            <fieldset>
              <legend class="font-display text-xl">Seus dados</legend>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <Field name="name" label="Nome completo" value={form.name} onInput={(v) => set('name', v)} error={fieldErrors.name} required autocomplete="name" wide />
                <Field name="email" label="E-mail" type="email" value={form.email} onInput={(v) => set('email', v)} error={fieldErrors.email} required autocomplete="email" />
                <Field name="phone" label="Telefone / WhatsApp" value={form.phone} onInput={(v) => set('phone', formatPhone(v))} error={fieldErrors.phone} required inputMode="tel" autocomplete="tel" placeholder="(11) 90000-0000" />
                <Field name="cpf" label="CPF" value={form.cpf} onInput={(v) => set('cpf', formatCpf(v))} error={fieldErrors.cpf} required inputMode="numeric" placeholder="000.000.000-00" />
              </div>
            </fieldset>

            <fieldset>
              <legend class="font-display text-xl">Entrega</legend>

              {savedAddresses.length > 0 && (
                <div class="mt-4 flex flex-wrap gap-2">
                  {savedAddresses.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => applySavedAddress(a.id)}
                      class={`rounded-card border px-3 py-2 text-left font-sans text-[12px] transition-colors ${
                        selectedAddressId === a.id ? 'border-ink bg-ink text-bone' : 'border-ink/20 text-ink-soft hover:border-ink'
                      }`}
                    >
                      <span class="block font-medium uppercase tracking-[0.08em]">{a.label}</span>
                      <span class="block opacity-80">{a.street}, {a.number} — {a.city}/{a.state}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      applySavedAddress('new');
                      setForm((f) => ({ ...f, cep: '', street: '', number: '', complement: '', district: '', city: '', state: '' }));
                    }}
                    class={`rounded-card border px-3 py-2 font-sans text-[12px] transition-colors ${
                      selectedAddressId === 'new' ? 'border-ink bg-ink text-bone' : 'border-ink/20 text-ink-soft hover:border-ink'
                    }`}
                  >
                    + Novo endereço
                  </button>
                </div>
              )}

              <div class="mt-4 grid gap-4 sm:grid-cols-6">
                <div class="sm:col-span-2">
                  <label class="label" for="cep">CEP</label>
                  <input
                    id="cep" class={`field${fieldErrors.cep ? ' border-red-400' : ''}`} required inputMode="numeric" autocomplete="postal-code"
                    value={form.cep}
                    onInput={(e) => set('cep', formatCep((e.target as HTMLInputElement).value))}
                    onBlur={(e) => lookupCep((e.target as HTMLInputElement).value)}
                  />
                  {cepLoading ? (
                    <p class="mt-1 text-[12px] text-ink-muted">Buscando…</p>
                  ) : fieldErrors.cep ? (
                    <p class="mt-1 text-[12px] text-red-700">{fieldErrors.cep}</p>
                  ) : null}
                </div>
                <div class="sm:col-span-3"><Field name="street" label="Rua" value={form.street} onInput={(v) => set('street', v)} error={fieldErrors.street} required autocomplete="address-line1" /></div>
                <div class="sm:col-span-1"><Field name="number" label="Número" value={form.number} onInput={(v) => set('number', v)} error={fieldErrors.number} required /></div>
                <div class="sm:col-span-3"><Field name="complement" label="Complemento" value={form.complement} onInput={(v) => set('complement', v)} /></div>
                <div class="sm:col-span-3"><Field name="district" label="Bairro" value={form.district} onInput={(v) => set('district', v)} error={fieldErrors.district} required /></div>
                <div class="sm:col-span-4"><Field name="city" label="Cidade" value={form.city} onInput={(v) => set('city', v)} error={fieldErrors.city} required /></div>
                <div class="sm:col-span-2"><Field name="state" label="UF" value={form.state} onInput={(v) => set('state', v.toUpperCase().slice(0, 2))} error={fieldErrors.state} required maxLength={2} /></div>
              </div>
              {shipping && (
                <p class="mt-3 text-[13px] text-agua-dark">
                  {shipping.label}: {shipping.cents === 0 ? 'grátis' : brl(shipping.cents)}
                </p>
              )}

              {isLoggedIn && selectedAddressId === 'new' && (
                <label class="mt-3 flex items-center gap-2 font-sans text-[13px] text-ink-soft">
                  <input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress((e.target as HTMLInputElement).checked)} />
                  Salvar este endereço na minha conta
                </label>
              )}
            </fieldset>

            <button type="submit" class="btn-primary w-full sm:w-auto" disabled={submitting}>
              {submitting ? 'Processando…' : 'Ir para o pagamento'}
            </button>
          </form>
        )}

        {step === 'payment' && order && (
          <div>
            <h2 class="font-display text-xl">Pagamento</h2>
            <p class="mt-1 text-[13px] text-ink-muted">Pedido {orderLabel(order.order_number)}</p>

            {MP_PUBLIC_KEY ? (
              <div id="mp-brick-container" class="mt-6" />
            ) : (
              <div class="mt-6 rounded-card border border-agua/40 bg-agua-wash/60 p-6">
                <p class="text-[13px] font-medium uppercase tracking-[0.12em] text-agua-dark">Modo demonstração</p>
                <p class="mt-2 text-[14px] leading-relaxed text-ink-soft">
                  As credenciais do Mercado Pago não estão configuradas. O botão abaixo simula um
                  pagamento aprovado e roda todo o fluxo real (pedido pago, baixa de estoque e
                  e-mail de confirmação). Configure <code>PUBLIC_MP_PUBLIC_KEY</code> e
                  <code> MP_ACCESS_TOKEN</code> para ativar Pix e cartão de verdade.
                </p>
                <button type="button" class="btn-primary mt-5" onClick={paySimulated} disabled={submitting}>
                  {submitting ? 'Confirmando…' : `Confirmar pagamento simulado — ${brl(order.total_cents)}`}
                </button>
              </div>
            )}
            <button type="button" class="mt-4 text-[12px] uppercase tracking-[0.12em] text-ink-muted hover:text-ink" onClick={() => setStep('form')}>
              ← Voltar aos dados
            </button>
          </div>
        )}

        {step === 'pix' && pix && (
          <div>
            <h2 class="font-display text-xl">Pague com Pix</h2>
            <p class="mt-2 text-[14px] text-ink-soft">Escaneie o QR Code ou copie o código. A confirmação é automática.</p>
            {pix.qrCodeBase64 && (
              <img src={`data:image/png;base64,${pix.qrCodeBase64}`} alt="QR Code Pix" width={220} height={220} class="mt-4 rounded-card border border-ink/10" />
            )}
            <div class="mt-4">
              <label class="label">Pix copia e cola</label>
              <textarea readOnly class="field font-mono text-[12px]" rows={3}>{pix.qrCode}</textarea>
              <button type="button" class="btn-outline mt-2" onClick={() => navigator.clipboard?.writeText(pix.qrCode)}>
                Copiar código
              </button>
            </div>
            <p class="mt-4 text-[13px] text-ink-muted">Aguardando pagamento…</p>
          </div>
        )}
      </div>

      {summary}
    </div>
  );
}

function Field(props: {
  name: string;
  label: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: string;
  maxLength?: number;
  wide?: boolean;
}) {
  const id = `co-${props.name}`;
  return (
    <div class={props.wide ? 'sm:col-span-2' : ''}>
      <label class="label" for={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        class={`field${props.error ? ' border-red-400 focus:border-red-400 focus:ring-red-400' : ''}`}
        type={props.type || 'text'}
        value={props.value}
        required={props.required}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        inputMode={props.inputMode as never}
        maxLength={props.maxLength}
        aria-invalid={props.error ? 'true' : undefined}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
      {props.error && <p class="mt-1 text-[12px] text-red-700">{props.error}</p>}
    </div>
  );
}

let sdkPromise: Promise<void> | null = null;
function loadMpSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    // @ts-expect-error global
    if (window.MercadoPago) return resolve();
    const script = document.createElement('script');
    script.src = 'https://sdk.mercadopago.com/js/v2';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Falha ao carregar o SDK do Mercado Pago.'));
    document.head.appendChild(script);
  });
  return sdkPromise;
}
