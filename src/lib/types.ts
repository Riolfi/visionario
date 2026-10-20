export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  position: number;
  image_url: string;
  /** null = categoria raiz (nível 1); preenchido = subcategoria (nível 2) */
  parent_id: string | null;
  /** inativa: some do menu, dos filtros e do sitemap da loja (0020) */
  is_active: boolean;
}

/** categoria raiz com suas subcategorias */
export type CategoryNode = Category & { children: Category[] };

export interface Product {
  id: string;
  slug: string;
  name: string;
  /** a subcategoria (nível 2) a que o produto pertence */
  category_id: string;
  category_slug: string;
  category_name: string;
  /** raiz → subcategoria, para trilha de navegação */
  category_path: { slug: string; name: string }[];
  short_description: string;
  description: string;
  ingredients: string;
  how_to_use: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  stock: number;
  /** EAN/UPC do leitor de código de barras — único quando presente, null se não cadastrado. */
  barcode: string | null;
  is_active: boolean;
  is_bestseller: boolean;
  rating: number | null;
  reviews_count: number;
  images: string[];
}

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'separating'
  | 'failed'
  | 'cancelled'
  | 'shipped'
  | 'delivered';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Aguardando pagamento',
  paid: 'Pago',
  separating: 'Em separação',
  failed: 'Pagamento não concluído',
  cancelled: 'Cancelado',
  shipped: 'Enviado',
  delivered: 'Entregue',
};

/** Situações em que o pagamento entrou (contam como recebido e o estoque já saiu). */
export const RECEIVED_STATUSES: OrderStatus[] = ['paid', 'separating', 'shipped', 'delivered'];

/**
 * Linha do tempo do pedido online: só avança. Aguardando pagamento → Pago →
 * Em separação → Enviado → Entregue (Pago pode ir direto a Enviado). Cancelar
 * tem fluxo próprio; Entregue e Cancelado são finais.
 */
export const ORDER_NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'failed'],
  failed: ['paid'],
  paid: ['separating', 'shipped'],
  separating: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};
export const FINAL_STATUSES: OrderStatus[] = ['delivered', 'cancelled'];

/** Motivos de cancelamento/devolução (política em lib/order-policy). */
export const CUSTOMER_CANCEL_REASONS = ['Desisti da compra', 'Comprei o produto errado', 'Encontrei mais barato', 'Prazo de entrega muito longo', 'Outro'];
export const RETURN_REASONS = ['Arrependimento (até 7 dias)', 'Produto com defeito', 'Tamanho incorreto', 'Produto diferente do anunciado', 'Outro'];
export const CANCEL_REASONS_ONLINE = ['Solicitação do cliente (CDC - 7 dias)', 'Suspeita de fraude', 'Falta de estoque', 'Pagamento não aprovado', 'Erro no pedido', 'Outro'];
export const CANCEL_REASONS_CAIXA = ['Devolução do produto no balcão', 'Erro de digitação do operador', 'Desistência imediata', 'Venda duplicada', 'Outro'];

/** motivo da lista + detalhe ("Outro" usa só o detalhe) */
export const joinReason = (motivo: string, detalhe: string) =>
  (motivo === 'Outro' ? detalhe : detalhe ? `${motivo} — ${detalhe}` : motivo).trim().slice(0, 500);


/** Rastreio: código dos Correios (AA123456789BR) ou link http(s) da transportadora. */
export function isValidTracking(v: string): boolean {
  const t = v.trim();
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t.toUpperCase())) return true;
  try {
    const u = new URL(t);
    return (u.protocol === 'https:' || u.protocol === 'http:') && /\.[a-z]{2,}$/i.test(u.hostname);
  } catch {
    return false;
  }
}
/** Código dos Correios em maiúsculas; link fica como veio. */
export const normalizeTracking = (v: string) => (/^https?:\/\//i.test(v.trim()) ? v.trim() : v.trim().toUpperCase());

export function orderStatusLabel(status: OrderStatus, source: 'web' | 'caixa'): string {
  return source === 'caixa' && status === 'paid' ? 'Concluída' : ORDER_STATUS_LABELS[status];
}

export type PaymentMethod = 'pix' | 'credit_card' | 'debit_card' | 'cash' | 'simulado' | 'misto';

/** Uma parte de um pagamento combinado (Caixa). No dinheiro, amount_cents é o valor recebido. */
export interface PaymentPart {
  method: Exclude<PaymentMethod, 'simulado' | 'misto'>;
  amount_cents: number;
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pix: 'Pix',
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  cash: 'Dinheiro',
  simulado: 'Simulado',
  misto: 'Combinado',
};

export interface OrderItem {
  id?: string;
  product_id: string;
  product_name: string;
  product_slug?: string;
  unit_price_cents: number;
  quantity: number;
}

export interface ShippingAddress {
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
}

export interface Order {
  id: string;
  order_number: string;
  status: OrderStatus;
  user_id?: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  customer_cpf: string;
  shipping_cep: string;
  shipping_address: ShippingAddress;
  shipping_cents: number;
  subtotal_cents: number;
  total_cents: number;
  payment_method: PaymentMethod | null;
  /** formas de um pagamento combinado (payment_method = 'misto') */
  payments?: PaymentPart[] | null;
  /** Caixa (0023): quem vendeu e quanto recebeu em dinheiro (só pagamento simples em dinheiro) */
  operator_id?: string | null;
  received_cents?: number | null;
  /** o cliente pediu o cancelamento (0024): só então a equipe cancela uma compra online */
  cancel_requested_at?: string | null;
  cancel_request_reason?: string | null;
  /** auditoria do cancelamento (0023) */
  cancel_reason?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  /** quando virou Entregue e pedido de devolução do cliente (0025) */
  delivered_at?: string | null;
  return_requested_at?: string | null;
  return_reason?: string | null;
  return_completed_at?: string | null;
  mp_payment_id: string | null;
  tracking_code: string | null;
  /** origem do pedido: 'web' (loja online) ou 'caixa' (venda de balcão). */
  source: 'web' | 'caixa';
  items: OrderItem[];
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  full_name: string;
  phone: string;
  cpf: string;
}

export interface Address {
  id: string;
  label: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  is_default: boolean;
}

export interface CartLine {
  productId: string;
  slug: string;
  name: string;
  priceCents: number;
  image: string;
  quantity: number;
  stock: number;
}

// --- Conteúdo editável no admin ---

export interface Offer {
  id: string;
  position: number;
  is_active: boolean;
  image_url: string;
  /** Arte alternativa para telas estreitas (art direction no carrossel). */
  image_url_mobile?: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta_label: string;
  cta_href: string;
}

export interface NavLink {
  label: string;
  href: string;
}

// ---------------------------------------------------------------------------
// Conteúdo editável do site (Parte 3 — /admin → Conteúdo)
// ---------------------------------------------------------------------------

export type SiteSectionKey =
  | 'brand'
  | 'home_bestsellers'
  | 'home_story'
  | 'home_social'
  | 'footer'
  | 'contact'
  | 'page_sobre'
  | 'page_contato';

export interface BrandContent {
  /** URL do logotipo do cabeçalho. Vazio → usa o nome da marca em texto. */
  logo_url: string;
}

export interface HomeBestsellersContent {
  eyebrow: string;
  title: string;
  cta_label: string;
  cta_href: string;
}

export interface HomeStoryContent {
  eyebrow: string;
  /** \n = quebra de linha */
  title: string;
  body: string;
  cta_label: string;
  cta_href: string;
  features: { title: string; body: string }[];
}

export interface HomeSocialContent {
  eyebrow: string;
  title: string;
  subtitle: string;
  testimonials: { quote: string; name: string; detail: string }[];
}

export interface FooterContent {
  tagline: string;
  returns_line: string;
  legal_line: string;
  payment_line: string;
}

export interface ContactContent {
  email: string;
  /** só dígitos (com DDI). Vazio → usa PUBLIC_WHATSAPP_NUMBER */
  whatsapp_number: string;
  hours: string;
}

export interface SobrePageContent {
  hero_eyebrow: string;
  /** \n = quebra de linha */
  hero_title: string;
  paragraphs: string[];
  values: { title: string; body: string }[];
  cta_title: string;
  cta_body: string;
  cta_label: string;
  cta_href: string;
}

export interface ContatoPageContent {
  eyebrow: string;
  title: string;
  intro: string;
  show_form: boolean;
}

export interface SiteSectionData {
  brand: BrandContent;
  home_bestsellers: HomeBestsellersContent;
  home_story: HomeStoryContent;
  home_social: HomeSocialContent;
  footer: FooterContent;
  contact: ContactContent;
  page_sobre: SobrePageContent;
  page_contato: ContatoPageContent;
}

export type SiteContent = {
  [K in SiteSectionKey]: { is_active: boolean; data: SiteSectionData[K] };
};
