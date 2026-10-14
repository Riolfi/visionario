import { brl } from './format';
import type { PaymentPart } from './types';

export const SPLIT_METHODS: PaymentPart['method'][] = ['cash', 'pix', 'debit_card', 'credit_card'];

/**
 * Confere um pagamento combinado do Caixa (mesma regra na tela e no servidor).
 * Dinheiro pode passar do total (vira troco); cartão e Pix não.
 * Retorna o motivo do erro, ou null se está ok.
 */
export function splitError(parts: PaymentPart[], totalCents: number): string | null {
  if (parts.length < 2) return 'Combine ao menos duas formas de pagamento.';
  const methods = parts.map((p) => p.method);
  if (methods.some((m) => !SPLIT_METHODS.includes(m))) return 'Forma de pagamento inválida.';
  if (new Set(methods).size !== methods.length) return 'Cada forma de pagamento entra uma vez só.';
  if (parts.some((p) => !Number.isInteger(p.amount_cents) || p.amount_cents <= 0)) return 'Informe o valor de cada forma de pagamento.';
  const nonCash = parts.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.amount_cents, 0);
  if (nonCash > totalCents) return 'Cartão e Pix não podem passar do total (só o dinheiro tem troco).';
  const paid = parts.reduce((s, p) => s + p.amount_cents, 0);
  if (paid < totalCents) return `Falta ${brl(totalCents - paid)}.`;
  return null;
}

/** Troco de um pagamento combinado (só sai do dinheiro). */
export const splitChange = (parts: PaymentPart[], totalCents: number) =>
  Math.max(0, parts.reduce((s, p) => s + p.amount_cents, 0) - totalCents);

/** Lê `payments` vindo do cliente (sem confiar no formato). */
export function parseParts(raw: unknown): PaymentPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { method: String(o.method) as PaymentPart['method'], amount_cents: Number(o.amount_cents) };
  });
}
