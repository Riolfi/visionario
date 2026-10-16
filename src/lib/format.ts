/** Formata centavos (int) como moeda brasileira: 6990 -> "R$ 69,90". */
export function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/** Apenas o número, sem símbolo: 6990 -> "69,90". */
export function brlNumber(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Parcelamento simples sem juros até 6x (mínimo de R$ 20 por parcela). */
export function installments(
  totalCents: number,
  maxInstallments = 6,
  minPerCents = 2000,
): { count: number; perCents: number } {
  let count = maxInstallments;
  while (count > 1 && totalCents / count < minPerCents) count--;
  return { count, perCents: Math.round(totalCents / count) };
}

/** Slug seguro a partir de um texto livre. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function onlyDigits(value: string): string {
  return (value || '').replace(/\D/g, '');
}

/** Máscara de CEP: "01310100" -> "01310-100". Retorna só dígitos se incompleto. */
export function formatCep(cep: string): string {
  const digits = onlyDigits(cep).slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

/** Máscara de CPF progressiva: "39053344705" -> "390.533.447-05". */
export function formatCpf(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** Máscara de telefone BR: "(11) 91234-5678" (celular) ou "(11) 1234-5678" (fixo). */
export function formatPhone(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function isValidPhone(value: string): boolean {
  const d = onlyDigits(value);
  return d.length === 10 || d.length === 11;
}

export function isValidCep(value: string): boolean {
  return onlyDigits(value).length === 8;
}

/** Número de pedido: 5 dígitos aleatórios (10000–99999), mostrado como
 *  "#13453". Aleatório, não sequencial, pra não revelar quantos pedidos a
 *  loja já teve. A unicidade é garantida em repo/orders (newOrderNumber). */
export function generateOrderNumber(digits = 5): string {
  const min = 10 ** (digits - 1);
  return String(min + Math.floor(Math.random() * 9 * min));
}

/** Como o número aparece pra pessoas: "#13453". Pedidos antigos
 *  (IAR-20260829-8F3A2) seguem como estão. */
export function orderLabel(orderNumber: string): string {
  return /^\d+$/.test(orderNumber) ? `#${orderNumber}` : orderNumber;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Validação de CPF (formato + dígitos verificadores). */
export function isValidCpf(cpf: string): boolean {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i]!, 10) * (len + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === parseInt(d[9]!, 10) && calc(10) === parseInt(d[10]!, 10);
}

/** Máscara de dinheiro enquanto digita: "1234" → "12,34" (centavos à direita). */
export function maskMoney(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9);
  if (!digits) return '';
  const cents = digits.padStart(3, '0');
  const int = cents.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${int},${cents.slice(-2)}`;
}
/** Valor mascarado → centavos ("" → 0). */
export const moneyToCents = (masked: string) => Number(masked.replace(/\D/g, '') || '0');

/**
 * Cores da etiqueta de situação do pedido (classes Tailwind):
 * aguardando = amarelo · pago = verde claro · em separação = azul · enviado = roxo ·
 * entregue/concluída = verde cheio · cancelado/não pago = vermelho.
 */
export function orderStatusBadge(status: string, source: 'web' | 'caixa' = 'web'): string {
  if (status === 'paid') return source === 'caixa' ? 'bg-green-600 text-white' : 'bg-green-100 text-green-800';
  return (
    {
      pending: 'bg-amber-100 text-amber-800',
      separating: 'bg-sky-100 text-sky-800',
      shipped: 'bg-purple-100 text-purple-800',
      delivered: 'bg-green-600 text-white',
      failed: 'bg-red-100 text-red-800',
      cancelled: 'bg-red-100 text-red-800',
    } as Record<string, string>
  )[status] ?? 'bg-bone-200 text-ink-soft';
}

/** Link do WhatsApp (wa.me/55 + DDD + número); vazio se o número não tiver DDD. */
export function whatsappUrl(phone: string): string {
  let d = onlyDigits(phone);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 ? `https://wa.me/55${d}` : '';
}
