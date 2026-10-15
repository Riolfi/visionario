import type { Offer, SiteContent, SiteSectionData, SiteSectionKey } from '../types';
import { hasSupabase } from '../env';
import { supabaseAdmin } from '../supabase';
import { readOffers, writeOffers, readSiteContent, writeSiteContent } from '../localstore';
import { DEFAULT_OFFERS, DEFAULT_SITE_CONTENT } from '../site-defaults';

export type { SiteContent } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToOffer(row: any): Offer {
  return {
    id: row.id,
    position: row.position ?? 0,
    is_active: row.is_active ?? true,
    image_url: row.image_url ?? '',
    image_url_mobile: row.image_url_mobile ?? '',
    eyebrow: row.eyebrow ?? '',
    title: row.title ?? '',
    subtitle: row.subtitle ?? '',
    cta_label: row.cta_label ?? '',
    cta_href: row.cta_href ?? '',
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface OfferInput {
  id?: string;
  is_active: boolean;
  image_url: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta_label: string;
  cta_href: string;
}

// ---------------------------------------------------------------------------
// Ofertas (carrossel da home)
// ---------------------------------------------------------------------------

export async function getOffers(opts: { activeOnly?: boolean } = {}): Promise<Offer[]> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    let q = sb.from('offers').select('*').order('position');
    if (opts.activeOnly) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) {
      // tabela ainda não existe (migration 0005) → não derruba a home
      console.warn('[site] offers indisponível:', error.message);
      return opts.activeOnly ? DEFAULT_OFFERS.filter((o) => o.is_active) : DEFAULT_OFFERS;
    }
    return (data ?? []).map(rowToOffer);
  }
  const stored = await readOffers();
  const list = stored ?? DEFAULT_OFFERS;
  const sorted = [...list].sort((a, b) => a.position - b.position);
  return opts.activeOnly ? sorted.filter((o) => o.is_active) : sorted;
}

export async function getOfferById(id: string): Promise<Offer | null> {
  const all = await getOffers();
  return all.find((o) => o.id === id) ?? null;
}

export async function saveOffer(input: OfferInput): Promise<{ ok: boolean; error?: string; id?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    if (input.id) {
      const { error } = await sb
        .from('offers')
        .update({ ...stripId(input), updated_at: new Date().toISOString() })
        .eq('id', input.id);
      return error ? { ok: false, error: error.message } : { ok: true, id: input.id };
    }
    const { count } = await sb.from('offers').select('id', { count: 'exact', head: true });
    const { data, error } = await sb
      .from('offers')
      .insert({ ...stripId(input), position: (count ?? 0) + 1 })
      .select('id')
      .single();
    return error ? { ok: false, error: error.message } : { ok: true, id: data.id };
  }

  const list = (await readOffers()) ?? [...DEFAULT_OFFERS];
  if (input.id) {
    const idx = list.findIndex((o) => o.id === input.id);
    if (idx < 0) return { ok: false, error: 'Oferta não encontrada.' };
    list[idx] = { ...list[idx], ...stripId(input) };
  } else {
    list.push({
      ...stripId(input),
      id: crypto.randomUUID(),
      position: list.length + 1,
    });
  }
  const wrote = await writeOffers(list);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

export async function deleteOffer(id: string): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('offers').delete().eq('id', id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const list = (await readOffers()) ?? [...DEFAULT_OFFERS];
  const wrote = await writeOffers(list.filter((o) => o.id !== id));
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

export async function reorderOffers(ids: string[]): Promise<{ ok: boolean }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    await Promise.all(
      ids.map((id, i) => sb.from('offers').update({ position: i + 1 }).eq('id', id)),
    );
    return { ok: true };
  }
  const list = (await readOffers()) ?? [...DEFAULT_OFFERS];
  const byId = new Map(list.map((o) => [o.id, o]));
  const next = ids
    .map((id, i) => {
      const o = byId.get(id);
      return o ? { ...o, position: i + 1 } : null;
    })
    .filter((o): o is Offer => o !== null);
  await writeOffers(next);
  return { ok: true };
}

function stripId(input: OfferInput): Omit<OfferInput, 'id'> {
  const { id: _id, ...rest } = input;
  return rest;
}

// ---------------------------------------------------------------------------
// Conteúdo editável do site (home, rodapé, Sobre, Contato, atendimento)
// ---------------------------------------------------------------------------

const SECTION_KEYS = Object.keys(DEFAULT_SITE_CONTENT) as SiteSectionKey[];

export function isSiteSectionKey(v: unknown): v is SiteSectionKey {
  return typeof v === 'string' && (SECTION_KEYS as string[]).includes(v);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mergeSection<K extends SiteSectionKey>(
  key: K,
  row: { is_active?: boolean; data?: any } | undefined,
): { is_active: boolean; data: SiteSectionData[K] } {
  const fallback = DEFAULT_SITE_CONTENT[key];
  if (!row) return { is_active: fallback.is_active, data: fallback.data };
  return {
    is_active: row.is_active ?? fallback.is_active,
    data: { ...fallback.data, ...(row.data ?? {}) },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function buildContent(
  rows: Record<string, { is_active?: boolean; data?: unknown }>,
): SiteContent {
  const out = {} as SiteContent;
  for (const key of SECTION_KEYS) {
    (out[key] as unknown) = mergeSection(key, rows[key]);
  }
  return out;
}

/** Conteúdo completo do site — sempre com todas as seções (defaults preenchem lacunas). */
export async function getSiteContent(): Promise<SiteContent> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { data, error } = await sb.from('site_content').select('*');
    if (error) {
      // tabela ainda não existe (migration 0007) → não derruba o site
      console.warn('[site] site_content indisponível:', error.message);
      return buildContent({});
    }
    const rows: Record<string, { is_active?: boolean; data?: unknown }> = {};
    for (const r of data ?? []) rows[r.section] = { is_active: r.is_active, data: r.data };
    return buildContent(rows);
  }
  const stored = await readSiteContent();
  return buildContent(stored as Record<string, { is_active?: boolean; data?: unknown }>);
}

export async function getSiteSection<K extends SiteSectionKey>(
  key: K,
): Promise<{ is_active: boolean; data: SiteSectionData[K] }> {
  const all = await getSiteContent();
  return all[key];
}

export async function saveSiteSection<K extends SiteSectionKey>(
  key: K,
  input: { is_active: boolean; data: SiteSectionData[K] },
): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb
      .from('site_content')
      .upsert(
        { section: key, is_active: input.is_active, data: input.data },
        { onConflict: 'section' },
      );
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const stored = (await readSiteContent()) as Record<string, unknown>;
  stored[key] = { is_active: input.is_active, data: input.data };
  const wrote = await writeSiteContent(stored);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}

export async function resetSiteSection(key: SiteSectionKey): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    const { error } = await sb.from('site_content').delete().eq('section', key);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const stored = (await readSiteContent()) as Record<string, unknown>;
  delete stored[key];
  const wrote = await writeSiteContent(stored);
  return wrote ? { ok: true } : { ok: false, error: 'Não foi possível gravar em .data/.' };
}
