import { z } from 'zod';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { createSha256Hasher } from '@/features/wesh/commands/sha256sum/sha256';
import { validModelPath } from './model-path';
import { inspectWeightFile } from './model-metadata';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';

const pendingName = '.llama-cpp-import-pending';
const mutationLock = 'naidan-llama-cpp-browser-model-mutation';
const chunkBytes = 256 * 1024;
const sourceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().refine(path => validModelPath({ path }) && /\.(gguf|safetensors|sft)$/i.test(path) && !path.split('/').some(part => part.startsWith('.'))),
});
const fileIdentitySchema = sourceSchema.extend({ size: z.number().int().min(8).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
type Identity = z.infer<typeof fileIdentitySchema>;
export type CatalogDownloadProgress = {
  phase: 'checking' | 'verifying' | 'transferring' | 'complete';
  index: number; count: number; path: string; repository: string; completed: number; total: number;
};
type Report = ({ progress }: { progress: CatalogDownloadProgress }) => void;
const treeSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), path: z.string() }),
  z.object({ type: z.literal('file'), path: z.string(), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lfs: z.object({ oid: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional() }),
])).max(10_000);
function notify({ report, progress }: { report: Report, progress: CatalogDownloadProgress }): void {
  try {
    report({ progress });
  } catch { /* A UI listener does not control a write. */ }
}
/** The caller must have a user download action; NEVER call on mount/focus/expand. */
async function identity({ file, signal }: { file: ImageRecipeFile, signal: AbortSignal }): Promise<Identity> {
  const source = sourceSchema.parse(file);
  const parent = source.path.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  const prefix = `/api/models/${source.repository}/tree/${source.revision}${parent ? '/' + parent : ''}`;
  let next: string | undefined = `https://huggingface.co${prefix}?recursive=false&expand=false&limit=1000`;
  const visited = new Set<string>();
  while (next) {
    signal.throwIfAborted();
    if (visited.size >= 32 || visited.has(next)) throw new Error('Invalid catalog metadata pagination');
    visited.add(next);
    const response = await privacyFetchStream({ request: { url: next, signal } });
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
      return fileIdentitySchema.parse({ ...source, size: match.size, sha256: match.lfs.oid });
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
async function fileHash({ file, signal, report }: { file: File, signal: AbortSignal, report: ({ bytes }: { bytes: number }) => void }): Promise<string> {
  const hash = createSha256Hasher(); let lastYield = performance.now();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal.throwIfAborted(); const expected = Math.min(chunkBytes, file.size - offset);
    const bytes = new Uint8Array(await file.slice(offset, offset + expected).arrayBuffer());
    if (bytes.byteLength !== expected) throw new Error('Stored model changed during verification');
    hash.update({ bytes }); report({ bytes: offset + bytes.length });
    if (performance.now() - lastYield > 40) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now();
    }
  }
  signal.throwIfAborted(); return hash.digestHex();
}
async function optionalFile({ folder, name }: { folder: FileSystemDirectoryHandle, name: string }): Promise<FileSystemFileHandle | undefined> {
  try {
    return await folder.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}
async function save({ file, signal, report }: { file: Identity, signal: AbortSignal, report: ({ phase, bytes }: { phase: 'transferring' | 'verifying', bytes: number }) => void }): Promise<void> {
  // Match the existing store's lock order. Cross-tab imports/removal and the
  // llama downloader must never race publication of a shared HF repository.
  await navigator.locks.request(mutationLock, { mode: 'exclusive', signal }, () =>
    navigator.locks.request(`naidan-llama-cpp-browser-hf:${file.repository}`, { mode: 'exclusive', signal }, async () => {
      signal.throwIfAborted();
      let folder = await navigator.storage.getDirectory();
      for (const part of ['models', 'huggingface.co', ...file.repository.split('/'), 'resolve', 'main']) folder = await folder.getDirectoryHandle(part, { create: true });
      if (await optionalFile({ folder, name: pendingName })) throw new Error('Repository has an unfinished operation; its existing data was not modified');
      const parts = file.path.split('/'); const name = parts.pop()!; let parent = folder;
      for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
      const existing = await optionalFile({ folder: parent, name });
      if (existing) {
        const snapshot = await existing.getFile();
        if (snapshot.size !== file.size || await fileHash({ file: snapshot, signal, report: ({ bytes }) => report({ phase: 'verifying', bytes }) }) !== file.sha256) throw new Error(`Existing file differs from the pinned source; preserved without overwrite: ${file.path}`);
        const current = await parent.getFileHandle(name); const now = await current.getFile();
        if (!await current.isSameEntry(existing) || now.size !== snapshot.size || now.lastModified !== snapshot.lastModified) throw new Error('Stored model changed during verification');
        return;
      }
      const marker = await folder.getFileHandle(pendingName, { create: true });
      let handle: FileSystemFileHandle | undefined; let snapshot: File | undefined;
      let committed = false;
      try {
        handle = await parent.getFileHandle(name, { create: true }); snapshot = await handle.getFile();
        const url = `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
        const response = await privacyFetchStream({ request: { url, signal } });
        let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
        let writer: FileSystemWritableFileStream | undefined;
        const cancel = () => {
          void reader?.cancel().catch(() => undefined);
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const length = response.headers.get('content-length');
          if (response.status !== 200 || length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size)) throw new Error(`Invalid model download response (HTTP ${response.status})`);
          signal.throwIfAborted(); writer = await handle.createWritable(); reader = response.body.getReader();
          const hash = createSha256Hasher(); let received = 0;
          while (true) {
            signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
            if (value.length > file.size - received) throw new Error('Download exceeds the verified file size');
            for (let offset = 0; offset < value.length; offset += chunkBytes) {
              signal.throwIfAborted(); const bytes = value.subarray(offset, offset + chunkBytes);
              hash.update({ bytes }); await writer.write(bytes); received += bytes.length;
              report({ phase: 'transferring', bytes: received });
            }
          }
          if (received !== file.size || hash.digestHex() !== file.sha256) throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
          signal.throwIfAborted(); await writer.close(); writer = undefined;
          snapshot = await handle.getFile();
          if (snapshot.size !== file.size) throw new Error('Stored model size mismatch');
          const inspection = await inspectWeightFile({ file: snapshot, signal });
          if (inspection.status !== 'weights' || inspection.value.unsupported) throw new Error('Downloaded file is not a supported model weight');
          signal.throwIfAborted();
          if (!await (await parent.getFileHandle(name)).isSameEntry(handle)) throw new Error('Model destination changed during download');
          committed = true;
        } finally {
          signal.removeEventListener('abort', cancel);
          if (reader) {
            await reader.cancel().catch(() => undefined); reader.releaseLock();
          } else await response.body.cancel().catch(() => undefined);
          await writer?.abort().catch(() => undefined);
        }
      } finally {
        let safeToPublish = committed;
        if (!committed && handle && snapshot) {
          // Never recursively delete a repository or remove a pre-existing file.
          const current = await optionalFile({ folder: parent, name });
          const now = await current?.getFile();
          if (!current) safeToPublish = true;
          else if (now && await current.isSameEntry(handle) && now.size === snapshot.size && now.lastModified === snapshot.lastModified) {
            await parent.removeEntry(name); safeToPublish = true;
          }
        } else if (!handle) safeToPublish = true;
        if (safeToPublish && await (await folder.getFileHandle(pendingName)).isSameEntry(marker)) await folder.removeEntry(pendingName);
        // Ambiguous external changes retain the marker and remain unpublished.
      }
    }));
}
/** Explicit acquisition only. Files are streamed/hashed, never ArrayBuffer-ed as
 * a whole. Completed files survive a later failure and are verified on retry. */
export async function downloadImageRecipe({ files, signal, onProgress }: { files: readonly ImageRecipeFile[], signal: AbortSignal, onProgress: Report }): Promise<void> {
  if (!files.length || files.length > 16) throw new Error('Invalid catalog file count');
  if (!navigator.locks || !navigator.storage?.getDirectory) throw new Error('Safe model download storage is unavailable');
  const planned: Identity[] = [];
  for (const [index, file] of files.entries()) {
    notify({ report: onProgress, progress: { phase: 'checking', index, count: files.length, path: file.path, repository: file.repository, completed: 0, total: 0 } });
    planned.push(await identity({ file, signal }));
  }
  for (const [index, file] of planned.entries()) {
    let reported = -Infinity;
    await save({ file, signal, report: ({ phase, bytes }) => {
      if (performance.now() - reported < 150 && bytes !== file.size) return; reported = performance.now();
      notify({ report: onProgress, progress: { phase, index, count: files.length, path: file.path, repository: file.repository, completed: bytes, total: file.size } });
    } });
    notify({ report: onProgress, progress: { phase: 'complete', index, count: files.length, path: file.path, repository: file.repository, completed: file.size, total: file.size } });
  }
}
export const TEST_ONLY = {
  identity,
  fileHash,
  save,
};
