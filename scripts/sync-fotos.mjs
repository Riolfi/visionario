/**
 * Leva ao banco só nome, textos e fotos dos produtos com foto local
 * (/images/...) e dos kits, por id — preço, estoque e ativo não mudam.
 *   node --env-file=.env scripts/sync-fotos.mjs            mostra o que mudaria
 *   node --env-file=.env scripts/sync-fotos.mjs --gravar   grava
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: ident } = await sb.from('store_identity').select('store').maybeSingle();
if (ident?.store !== 'visionario') { console.error('banco não é da Visionário:', ident?.store); process.exit(1); }
const cat = JSON.parse(await readFile('src/data/catalog.json', 'utf8'));
const want = cat.products.filter((p) => p.images.some((i) => i.startsWith('/images/')) || p.slug.startsWith('kit-'));
const F = ['name', 'short_description', 'description', 'ingredients', 'images'];
const { data: rows, error } = await sb.from('products').select(['id', 'slug', ...F].join(',')).in('id', want.map((p) => p.id));
if (error) throw error;
const gravar = process.argv.includes('--gravar');
for (const p of want) {
  const r = rows.find((x) => x.id === p.id);
  if (!r) { console.log('NÃO EXISTE no banco:', p.slug); continue; }
  const diff = F.filter((f) => JSON.stringify(r[f]) !== JSON.stringify(p[f]));
  if (!diff.length) { console.log('igual:', p.slug); continue; }
  console.log(`${p.slug}: ${diff.join(', ')}${diff.includes('name') ? `  ("${r.name}" → "${p.name}")` : ''}`);
  if (gravar) {
    const patch = Object.fromEntries(diff.map((f) => [f, p[f]]));
    const { error: e } = await sb.from('products').update(patch).eq('id', p.id);
    console.log(e ? '  ✗ ' + e.message : '  ✓ gravado');
  }
}
