import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hasSupabase } from './env';
import { supabaseAdmin } from './supabase';

const BUCKET = 'product-images';
const LOCAL_DIR = path.resolve(process.cwd(), '.data', 'uploads');

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function isAllowedImage(type: string): boolean {
  return type in EXT_BY_TYPE;
}

let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const sb = supabaseAdmin();
  if (!sb) return;
  const { data } = await sb.storage.getBucket(BUCKET);
  if (!data) {
    await sb.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_UPLOAD_BYTES,
      allowedMimeTypes: Object.keys(EXT_BY_TYPE),
    });
  }
  bucketReady = true;
}

export type UploadFolder = 'products' | 'offers' | 'categorias' | 'site' | 'avatars';
// avatars: só pela foto do Meu perfil (a rota de upload genérica não aceita)
const FOLDERS: UploadFolder[] = ['products', 'offers', 'categorias', 'site'];

export function isAllowedFolder(v: string): v is UploadFolder {
  return (FOLDERS as string[]).includes(v);
}

/**
 * Salva uma imagem e devolve a URL pública.
 * - Com Supabase: bucket público `product-images`, pasta `<folder>/`.
 * - Sem Supabase (dev): grava em `.data/uploads/` e serve via `/uploads/<arquivo>`.
 */
export async function uploadImage(
  file: File,
  folder: UploadFolder = 'products',
  opts: { maxBytes?: number; allowedTypes?: string[] } = {},
): Promise<{ url: string } | { error: string }> {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  if (opts.allowedTypes) {
    if (!opts.allowedTypes.includes(file.type)) {
      return { error: 'Formato não suportado. Use PNG ou WebP.' };
    }
  } else if (!isAllowedImage(file.type)) {
    return { error: 'Formato não suportado (use JPG, PNG, WebP ou AVIF).' };
  }
  if (!(file.type in EXT_BY_TYPE)) return { error: 'Formato não suportado.' };
  if (file.size > maxBytes) {
    return { error: `Arquivo acima de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  }

  const ext = EXT_BY_TYPE[file.type];
  const name = `${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const sb = supabaseAdmin();
  if (hasSupabase && sb) {
    await ensureBucket();
    const key = `${folder}/${name}`;
    const { error } = await sb.storage.from(BUCKET).upload(key, bytes, {
      contentType: file.type,
      upsert: false,
    });
    if (error) return { error: error.message };
    const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
    return { url: data.publicUrl };
  }

  // Fallback local
  try {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, name), bytes);
    return { url: `/uploads/${name}` };
  } catch {
    return { error: 'Não foi possível gravar o arquivo (filesystem somente-leitura?).' };
  }
}

/** Compat: upload de imagem de produto. */
export function uploadProductImage(file: File) {
  return uploadImage(file, 'products');
}

export async function readLocalUpload(name: string): Promise<{ body: Uint8Array; type: string } | null> {
  const safe = path.basename(name);
  const ext = safe.split('.').pop()?.toLowerCase() ?? '';
  const type = Object.entries(EXT_BY_TYPE).find(([, e]) => e === ext)?.[0];
  if (!type) return null;
  try {
    const buf = await fs.readFile(path.join(LOCAL_DIR, safe));
    const body = new Uint8Array(buf.byteLength);
    body.set(buf);
    return { body, type };
  } catch {
    return null;
  }
}
