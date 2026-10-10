import { z } from 'zod';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import { createSha256Hasher, type Sha256Hasher } from '@/features/wesh/commands/sha256sum/sha256';
import { responseOffset } from '@/features/llama-cpp-browser/hugging-face/download-response';
import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { hostModelDirectoryLock, hostModelPermissionGranted } from '@/logic/host-model-directories';
import { modelFileMarker, optionalModelFile, publishModelFile, readModelMarkerJson, writeModelMarkerJson } from '@/logic/model-file-publication';
import { inspectWeightFile, type ModelMetadataFile } from './model-metadata';
import { imageFileIdentitySchema, type ImageFileIdentity } from './catalog-source';
import { openModelDownloadAccess, type ModelDownloadAccess } from './model-download-access';
import type { ImageDownloadDestination } from './catalog-download';

const chunkBytes = 256 * 1024;
const pendingSchema = z.object({
  version: z.literal(1),
  kind: z.literal('naidan-image-download'),
  source: imageFileIdentitySchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['partial', 'invalid']),
}).strict().refine(value => value.bytes <= value.source.size);
type Pending = z.infer<typeof pendingSchema>;
export type FileTransferProgress = { phase: 'transferring' | 'verifying', bytes: number, processed: number };

/** Permit cancellation messages without adding a timer delay per 256 KiB. */
function createYieldPoint(): () => Promise<void> {
  let yieldedAt = performance.now();
  return async () => {
    if (performance.now() - yieldedAt < 40) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    yieldedAt = performance.now();
  };
}

async function hashFile({ file, signal, report }: { file: File, signal: AbortSignal, report: ({ bytes }: { bytes: number }) => void }): Promise<string> {
  const hash = createSha256Hasher(), yieldIfDue = createYieldPoint();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer());
    if (bytes.length !== Math.min(chunkBytes, file.size - offset)) throw new Error('Stored file changed during verification');
    hash.update({ bytes }); report({ bytes: offset + bytes.length });
    await yieldIfDue();
  }
  signal.throwIfAborted(); return hash.digestHex();
}

function sourceReceipt({ file }: { file: ImageFileIdentity }) {
  return { kind: 'hugging-face' as const, repository: file.repository, revision: file.revision, path: file.path, sha256: file.sha256 };
}

async function assertWeights({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal }): Promise<void> {
  const inspection = await inspectWeightFile({ file, signal });
  if (inspection.status !== 'weights' || inspection.value.unsupported) throw new Error('Downloaded file is not a supported model weight');
}

function sameSource({ a, b }: { a: ImageFileIdentity, b: ImageFileIdentity }): boolean {
  return a.repository === b.repository && a.revision === b.revision && a.path === b.path && a.size === b.size && a.sha256 === b.sha256;
}

/** Runs in a dedicated Worker. Pending bytes are never inference inputs, even
 * when their small GGUF header looks valid. Sync writes checkpoint after flush;
 * resume hashes the stored prefix before accepting any Range response suffix.
 */
export async function saveImageCatalogFile({ file, signal, report, fetch, destination }: {
  fetch: CatalogFetch,
  file: ImageFileIdentity, signal: AbortSignal, report: ({ progress }: { progress: FileTransferProgress }) => void,
  destination?: ImageDownloadDestination,
}): Promise<void> {
  const target = destination ?? { kind: 'opfs' };
  const mutationLock = (() => {
    switch (target.kind) {
    case 'host': return hostModelDirectoryLock({ id: toHostModelDirectoryId({ raw: target.directoryId }) });
    case 'opfs': return 'naidan-llama-cpp-browser-model-mutation';
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  })();
  await navigator.locks.request(mutationLock, { mode: 'exclusive', signal }, () =>
    navigator.locks.request(`naidan-llama-cpp-browser-hf:${file.repository}`, { mode: 'exclusive', signal }, async () => {
      signal.throwIfAborted();
      let root: FileSystemDirectoryHandle;
      let rootPath: string[];
      switch (target.kind) {
      case 'opfs':
        root = await navigator.storage.getDirectory();
        rootPath = ['models', 'huggingface.co', ...file.repository.split('/'), 'resolve', 'main'];
        break;
      case 'host': {
        const handle = await hostModelHandles.get({ id: toHostModelDirectoryId({ raw: target.directoryId }) });
        if (!handle) throw new Error('Reconnect the linked model directory before downloading');
        if (!hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'readwrite' }) })) throw new Error('Linked model directory needs read and write permission');
        root = handle; rootPath = file.repository.split('/');
        break;
      }
      default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
      }
      for (const part of rootPath) root = await root.getDirectoryHandle(part, { create: true });
      if (await optionalModelFile({ directory: root, name: '.llama-cpp-import-pending' })) throw new Error('Repository has an unfinished operation; its existing data was not modified');
      const parts = file.path.split('/'); const name = parts.pop()!; let directory = root;
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      const pendingName = modelFileMarker({ name, state: 'pending' });
      const completeName = modelFileMarker({ name, state: 'complete' });
      const pendingHandle = await optionalModelFile({ directory, name: pendingName });
      let pending: Pending | undefined;
      if (pendingHandle) {
        pending = pendingSchema.parse(await readModelMarkerJson({ handle: pendingHandle }));
        if (!sameSource({ a: pending.source, b: file })) throw new Error('Another download owns this pending file; existing data was preserved');
      }
      let handle = await optionalModelFile({ directory, name });
      if (handle && !pending) {
        // Upgrade old markerless downloads by verification, never by size alone.
        // This also reuses a llama.cpp-installed encoder without downloading its
        // payload again. An unrelated existing file is never truncated.
        const snapshot = await handle.getFile();
        if (snapshot.size !== file.size || await hashFile({ file: snapshot, signal, report: ({ bytes }) => report({ progress: { phase: 'verifying', bytes, processed: 0 } }) }) !== file.sha256) {
          throw new Error(`Existing file differs from the pinned source; preserved without overwrite: ${file.path}`);
        }
        await assertWeights({ file: snapshot, signal }); signal.throwIfAborted();
        await publishModelFile({ directory, name, handle, file: snapshot, source: sourceReceipt({ file }) });
        return;
      }
      if (!pending) {
        pending = { version: 1, kind: 'naidan-image-download', source: file, bytes: 0, state: 'partial' };
        await writeModelMarkerJson({ directory, name: pendingName, value: pendingSchema.parse(pending) });
      }
      if (!handle) {
        if (pending.bytes !== 0) throw new Error('Pending model file is missing; its journal was preserved');
        handle = await directory.getFileHandle(name, { create: true });
        if ((await handle.getFile()).size !== 0) throw new Error('Model destination changed during creation');
      }
      // A crash may leave both markers. Pending continues to suppress the file
      // until this exact source is verified and its receipt is republished.
      if (await optionalModelFile({ directory, name: completeName })) await directory.removeEntry(completeName);
      let access: ModelDownloadAccess | undefined;
      let received = pending.bytes, processed = 0, checkpointBytes = pending.bytes;
      let hash: Sha256Hasher = createSha256Hasher();
      const yieldIfDue = createYieldPoint();
      let body: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
      let succeeded = false;
      const checkpoint = async (): Promise<void> => {
        if (!access) return;
        await access.flush(); pending!.bytes = received;
        await writeModelMarkerJson({ directory, name: pendingName, value: pendingSchema.parse(pending) });
        checkpointBytes = received;
      };
      const abortRead = (): void => {
        void reader?.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', abortRead, { once: true });
      try {
        access = await openModelDownloadAccess({ handle, kind: target.kind, offset: received });
        const actual = access.getSize();
        if (actual < pending.bytes || actual > file.size) throw new Error('Pending model differs from its journal; preserved without overwrite');
        switch (pending.state) {
        case 'partial': break;
        case 'invalid': {
          received = 0; pending.bytes = 0; pending.state = 'partial';
          // This is an explicit retry of our failed download, not an existing
          // user file. Persist the restart intent before removing its bad bytes.
          await writeModelMarkerJson({ directory, name: pendingName, value: pendingSchema.parse(pending) });
          break;
        }
        default: { const exhaustive: never = pending.state; throw new Error(String(exhaustive)); }
        }
        await access.truncate({ size: received });
        const buffer = new Uint8Array(chunkBytes);
        for (let offset = 0; offset < received; offset += chunkBytes) {
          signal.throwIfAborted(); const bytes = buffer.subarray(0, Math.min(chunkBytes, received - offset));
          if (await access.read({ bytes, at: offset }) !== bytes.length) throw new Error('Short read in pending model prefix');
          hash.update({ bytes }); report({ progress: { phase: 'verifying', bytes: offset + bytes.length, processed } });
          await yieldIfDue();
        }
        if (received < file.size) {
          signal.throwIfAborted();
          const url = `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
          const response = await fetch({ request: { url, signal, ...(received ? { headers: [['Range', `bytes=${received}-`]] } : {}) } });
          body = response.body;
          const start = responseOffset({ status: response.status, headers: response.headers, offset: received, size: file.size });
          signal.throwIfAborted();
          if (start !== received) {
            received = start; hash = createSha256Hasher(); await access.truncate({ size: start });
            switch (access.checkpointMode) {
            case 'periodic': await checkpoint(); break;
            case 'on-close': break;
            default: { const exhaustive: never = access.checkpointMode; throw new Error(String(exhaustive)); }
            }
          }
          report({ progress: { phase: 'transferring', bytes: received, processed } });
          reader = body.getReader();
          while (true) {
            signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
            if (value.length > file.size - received) throw new Error('Download exceeds expected size');
            for (let offset = 0; offset < value.length; offset += chunkBytes) {
              signal.throwIfAborted(); const bytes = value.subarray(offset, offset + chunkBytes);
              const count = await access.write({ bytes, at: received });
              if (count !== bytes.length) throw new Error('Incomplete model storage write');
              hash.update({ bytes }); received += count; processed += count;
              if (access.checkpointMode === 'periodic' && received - checkpointBytes >= 16 * 1024 * 1024) await checkpoint();
              report({ progress: { phase: 'transferring', bytes: received, processed } });
              // Let abort messages reach this Worker during cached/local streams.
              await yieldIfDue();
            }
          }
        }
        if (received !== file.size) throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
        report({ progress: { phase: 'verifying', bytes: received, processed } });
        if (hash.digestHex() !== file.sha256) {
          pending.state = 'invalid'; throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
        }
        signal.throwIfAborted(); await checkpoint(); await access.close(); access = undefined;
        const snapshot = await handle.getFile();
        if (snapshot.size !== file.size) throw new Error('Stored model size mismatch');
        await assertWeights({ file: snapshot, signal });
        await publishModelFile({ directory, name, handle, file: snapshot, source: sourceReceipt({ file }) });
        signal.throwIfAborted();
        // The sole publication point. A failure above retains pending, even if
        // writing the complete receipt itself was interrupted.
        await directory.removeEntry(pendingName); succeeded = true;
      } finally {
        signal.removeEventListener('abort', abortRead);
        if (reader) {
          await reader.cancel().catch(() => undefined); reader.releaseLock();
        } else await body?.cancel().catch(() => undefined);
        try {
          if (!succeeded) await checkpoint();
        } finally {
          await access?.close();
        }
      }
    }));
}

export const TEST_ONLY = {
  hashFile,
  pendingSchema,
};
