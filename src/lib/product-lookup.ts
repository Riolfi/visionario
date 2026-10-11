import { env } from './env';

/**
 * Dados públicos de um produto pelo código de barras (GTIN/EAN), pra
 * pré-preencher o cadastro. Fontes, em ordem:
 *   1. Cosmos (Bluesoft) — maior base brasileira; só se COSMOS_TOKEN existir
 *   2. Open Food / Beauty / Products Facts — gratuitas, sem chave
 * Best-effort: qualquer falha ou demora vira "não encontrado", nunca erro.
 * Nunca traz preço (o preço é da loja).
 */
export interface LookupResult {
  source: 'cosmos' | 'openfoodfacts' | 'openbeautyfacts' | 'openproductsfacts';
  name: string;
  brand: string | null;
  description: string | null;
  image: string | null;
}

const TIMEOUT_MS = 4000;
const UA = `${env.brandName}-admin/1.0 (cadastro de produtos)`;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

async function fromCosmos(code: string): Promise<LookupResult | null> {
  if (!env.cosmosToken) return null;
  const d = (await getJson(`https://api.cosmos.bluesoft.com.br/gtins/${code}.json`, {
    'X-Cosmos-Token': env.cosmosToken,
  })) as { description?: string; brand?: { name?: string }; thumbnail?: string; ncm?: { full_description?: string } } | null;
  const name = clean(d?.description);
  if (!name) return null;
  return {
    source: 'cosmos',
    name,
    brand: clean(d?.brand?.name) || null,
    description: null,
    image: clean(d?.thumbnail) || null,
  };
}

const OFF_HOSTS = [
  ['openfoodfacts', 'world.openfoodfacts.org'],
  ['openbeautyfacts', 'world.openbeautyfacts.org'],
  ['openproductsfacts', 'world.openproductsfacts.org'],
] as const;

async function fromOpenFacts(code: string): Promise<LookupResult | null> {
  const fields = 'product_name_pt,product_name,generic_name_pt,generic_name,brands,quantity,image_front_url';
  const results = await Promise.all(
    OFF_HOSTS.map(async ([source, host]) => {
      const d = (await getJson(`https://${host}/api/v2/product/${code}.json?fields=${fields}`)) as {
        status?: number;
        product?: Record<string, string>;
      } | null;
      const p = d?.status === 1 ? d.product : null;
      const name = clean(p?.product_name_pt) || clean(p?.product_name);
      if (!p || !name) return null;
      const generic = clean(p.generic_name_pt) || clean(p.generic_name);
      const qty = clean(p.quantity);
      return {
        source,
        name: qty && !name.includes(qty) ? `${name} ${qty}` : name,
        brand: clean(p.brands).split(',')[0]?.trim() || null,
        description: generic && generic.toLowerCase() !== name.toLowerCase() ? generic : null,
        image: clean(p.image_front_url) || null,
      } satisfies LookupResult;
    }),
  );
  return results.find(Boolean) ?? null;
}

export async function lookupBarcode(rawCode: string): Promise<LookupResult | null> {
  const code = rawCode.replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) return null;
  return (await fromCosmos(code)) ?? (await fromOpenFacts(code));
}
