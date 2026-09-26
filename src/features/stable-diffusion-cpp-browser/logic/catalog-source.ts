import { z } from 'zod';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import { validModelPath } from './model-path';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
export const imageDownloadSourceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().refine(path => validModelPath({ path }) && /\.(gguf|safetensors|sft)$/i.test(path) && !path.split('/').some(part => part.startsWith('.'))),
});
export const imageFileIdentitySchema = imageDownloadSourceSchema.extend({ size: z.number().int().min(8).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type ImageFileIdentity = z.infer<typeof imageFileIdentitySchema>;
const treeSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), path: z.string() }),
  z.object({ type: z.literal('file'), path: z.string(), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lfs: z.object({ oid: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional() }),
])).max(10_000);
/** The caller must have a user download action; NEVER call on mount/focus/expand. */
export async function imageFileIdentity({ file, signal, fetch }: { file: ImageRecipeFile, signal: AbortSignal, fetch: CatalogFetch }): Promise<ImageFileIdentity> {
  const source = imageDownloadSourceSchema.parse(file);
  const parent = source.path.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  const prefix = `/api/models/${source.repository}/tree/${source.revision}${parent ? '/' + parent : ''}`;
  let next: string | undefined = `https://huggingface.co${prefix}?recursive=false&expand=false&limit=1000`;
  const visited = new Set<string>();
  while (next) {
    signal.throwIfAborted();
    if (visited.size >= 32 || visited.has(next)) throw new Error('Invalid catalog metadata pagination');
    visited.add(next);
    const response = await fetch({ request: { url: next, signal } });
    if (response.status !== 200) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`Hugging Face metadata HTTP ${response.status}: ${source.repository}`);
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let data: unknown;
    try {
      while (true) {
        signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
        total += value.byteLength;
        if (total > 4 * 1024 * 1024) throw new Error('Catalog metadata exceeds its bounded size');
        chunks.push(value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset); offset += part.length;
      }
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      await reader.cancel().catch(() => undefined); throw error;
    } finally {
      signal.removeEventListener('abort', cancel); reader.releaseLock();
    }
    const matches = treeSchema.parse(data).filter(entry => entry.type === 'file' && entry.path === source.path);
    if (matches.length > 1) throw new Error('Duplicate catalog file metadata');
    const match = matches[0];
    switch (match?.type) {
    case 'file': {
      if (!match.lfs || match.lfs.size !== match.size) throw new Error('Catalog file has no verifiable SHA-256 identity');
      return imageFileIdentitySchema.parse({ ...source, size: match.size, sha256: match.lfs.oid });
    }
    case 'directory': case undefined: break;
    default: { const exhaustive: never = match; throw new Error(String(exhaustive)); }
    }
    const link: RegExpMatchArray | null = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/) ?? null;
    next = undefined;
    if (link) {
      const url = new URL(link[1]!, 'https://huggingface.co');
      if (url.origin !== 'https://huggingface.co' || url.pathname !== prefix || url.username || url.password || url.hash) throw new Error('Unsafe catalog pagination URL');
      next = url.href;
    }
  }
  throw new Error(`Catalog file is unavailable at the pinned revision: ${source.repository}/${source.path}`);
}
export const TEST_ONLY = {
};
