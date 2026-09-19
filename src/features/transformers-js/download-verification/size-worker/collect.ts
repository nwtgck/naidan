import { z } from 'zod';
import { downloadSizeRequestSchema, type DownloadSizeRequest, type DownloadSizeResult } from './types';

const entrySchema = z.object({ type: z.literal('file'), path: z.string(), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), lfs: z.object({ size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional() });
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

/** Optional metadata only. No model resolve URL, OPFS or runtime capability. */
export async function collectDownloadSizes({ request, repositoryFetch, signal }: {
  request: DownloadSizeRequest; repositoryFetch: typeof fetch; signal: AbortSignal;
}): Promise<DownloadSizeResult> {
  const parsed = downloadSizeRequestSchema.safeParse(request);
  const result: DownloadSizeResult = { sizes: [], quotaLimited: false };
  if (!parsed.success) return result;
  const { modelId, revision, paths } = parsed.data;
  if (modelId.split('/').some(part => part === '.' || part === '..')) return result;
  const url = `https://huggingface.co/api/models/${modelId.split('/').map(encodeURIComponent).join('/')}/paths-info/${revision}`;
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const path of new Set(paths)) {
    if (path.split('/').some(part => part === '' || part === '.' || part === '..')) continue;
    const form = new URLSearchParams([['expand', 'false'], ...[...batch, path].map(value => ['paths', value])]);
    if (batch.length >= 64 || new TextEncoder().encode(form.toString()).byteLength > MAX_REQUEST_BYTES) {
      if (batch.length > 0) batches.push(batch);
      batch = [];
      if (batches.length === 4) break;
    }
    const single = new URLSearchParams({ expand: 'false', paths: path });
    if (new TextEncoder().encode(single.toString()).byteLength <= MAX_REQUEST_BYTES) batch.push(path);
  }
  if (batch.length > 0 && batches.length < 4) batches.push(batch);
  for (const selected of batches) {
    if (signal.aborted) break;
    const controller = new AbortController();
    const deadline = Promise.withResolvers<undefined>();
    const abort = () => {
      controller.abort(); deadline.resolve(undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      controller.abort(); deadline.resolve(undefined);
    }, 2_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      const operation = (async () => {
        const body = new URLSearchParams([['expand', 'false'], ...selected.map(path => ['paths', path])]);
        response = await repositoryFetch(url, { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined); return undefined;
        }
        controller.signal.throwIfAborted();
        if (response.status === 429 || response.status === 403) result.quotaLimited = true;
        if (response.status !== 200 || response.headers.has('Content-Range') || response.body === null) return undefined;
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const next = await reader.read();
          controller.signal.throwIfAborted();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) return undefined;
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset); offset += chunk.byteLength;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(value) || value.length > 64) return undefined;
        const allowed = new Set(selected);
        const seen = new Set<string>();
        const invalid = new Set<string>();
        const sizes = new Map<string, number>();
        for (const entry of value) {
          const item = entrySchema.safeParse(entry);
          const path = typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string' ? entry.path : undefined;
          if (path === undefined || !allowed.has(path)) continue;
          if (seen.has(path) || !item.success || item.data.lfs !== undefined && item.data.lfs.size !== item.data.size) invalid.add(path);
          seen.add(path);
          if (item.success) sizes.set(path, item.data.size);
        }
        return [...sizes].filter(([path]) => !invalid.has(path)).map(([path, size]) => ({ path, bytes: size }));
      })();
      const sizes = await Promise.race([operation, deadline.promise]);
      if (sizes === undefined) break;
      result.sizes.push(...sizes);
    } catch {
      // Size information never classifies a candidate as missing or failed.
      break;
    } finally {
      controller.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (reader !== undefined) {
        void reader.cancel().catch(() => undefined).finally(() => {
          try {
            reader?.releaseLock();
          } catch { /* Advisory cleanup. */ }
        });
      } else void response?.body?.cancel().catch(() => undefined);
    }
  }
  return result;
}
export const TEST_ONLY = {
};
