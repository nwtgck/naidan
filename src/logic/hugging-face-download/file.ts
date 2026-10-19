import { pendingDownloadSchema, readPendingDownload } from './pending';
import type { DownloadFetch } from './fetch-types';
import { createSha256Hasher, type Sha256Hasher } from '@/utils/sha256';
import { responseOffset } from './response';
import { withDownloadRepository } from './storage';
import { modelFileMarker, optionalModelFile, publishModelFile, readModelMarkerJson, writeModelMarkerJson } from '@/logic/model-file-publication';
import { inspectWeightFile, type ModelMetadataFile } from '@/logic/model-file-inspection/metadata';
import { huggingFaceFileSchema, type HuggingFaceFile } from './source';
import { openModelDownloadAccess, type ModelDownloadAccess } from './access';
import type { DownloadDestination } from '@/01-models/download';

const chunkBytes = 256 * 1024;
export type FileTransferProgress = { phase: 'transferring' | 'verifying', bytes: number, processed: number };

/** Permit cancellation messages without adding a timer delay per 256 KiB. */
function createYieldPoint(): () => Promise<void> {
  let yieldedAt = performance.now();
  return async () => {
    if (performance.now() - yieldedAt < 40) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    yieldedAt = performance.now();
  };
}

async function hashFile({ file, signal, report }: { file: File, signal: AbortSignal, report: ({ bytes }: { bytes: number }) => void }): Promise<string> {
  const hash = createSha256Hasher(), yieldIfDue = createYieldPoint();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer());
    if (bytes.length !== Math.min(chunkBytes, file.size - offset)) {
      throw new Error('Stored file changed during verification');
    }
    hash.update({ bytes });
    report({ bytes: offset + bytes.length });
    await yieldIfDue();
  }
  signal.throwIfAborted();
  return hash.digestHex();
}

function sourceReceipt({ file }: { file: HuggingFaceFile }) {
  return { kind: 'hugging-face' as const, repository: file.repository, revision: file.revision, path: file.path, sha256: file.sha256 };
}

async function assertWeights({ file, signal }: { file: ModelMetadataFile, signal: AbortSignal }): Promise<void> {
  const inspection = await inspectWeightFile({ file, signal });
  if (inspection.status !== 'weights' || inspection.value.unsupported) {
    throw new Error('Downloaded file is not a supported model weight');
  }
}

function sameSource({ a, b }: { a: HuggingFaceFile, b: HuggingFaceFile }): boolean {
  return a.repository === b.repository && a.revision === b.revision && a.path === b.path && a.size === b.size && a.sha256 === b.sha256;
}

/** Runs in a dedicated Worker. Pending bytes are never inference inputs, even
 * when their small GGUF header looks valid. Sync writes checkpoint after flush;
 * resume hashes the stored prefix before accepting any Range response suffix.
 */
export async function saveHuggingFaceFile({ file, signal, report, fetch, destination, expectedRoot, validation }: {
  fetch: DownloadFetch,
  file: HuggingFaceFile, signal: AbortSignal, report: ({ progress }: { progress: FileTransferProgress }) => void,
  destination?: DownloadDestination,
  expectedRoot: FileSystemDirectoryHandle | undefined,
  validation: 'model-weight' | 'none',
}): Promise<void> {
  file = huggingFaceFileSchema.parse(file);
  const target = destination ?? { kind: 'opfs' };
  await withDownloadRepository({
    repository: file.repository,
    destination: target,
    expectedRoot,
    signal,
    run: async ({ folder: root }) => {
      if (await optionalModelFile({ directory: root, name: '.llama-cpp-import-pending' })) {
        throw new Error('Repository has an unfinished operation; its existing data was not modified');
      }
      const parts = file.path.split('/');
      const name = parts.pop()!;
      let directory = root;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      const pendingName = modelFileMarker({ name, state: 'pending' });
      const completeName = modelFileMarker({ name, state: 'complete' });
      const pendingHandle = await optionalModelFile({ directory, name: pendingName });
      let pending: ReturnType<typeof readPendingDownload> | undefined;
      let ownedMarker = pendingHandle;
      let observedMarker: string | undefined;
      let lostOwnership = false;
      const assertPending = async (): Promise<void> => {
        try {
          const current = await optionalModelFile({ directory, name: pendingName });
          if (!current || !ownedMarker || !await current.isSameEntry(ownedMarker) || JSON.stringify(await readModelMarkerJson({ handle: current })) !== observedMarker) {
            lostOwnership = true;
            throw new Error('Pending download ownership changed; existing data was preserved');
          }
        } catch (error) {
          lostOwnership = true;
          throw error;
        }
      };
      const writePending = async (): Promise<void> => {
        if (ownedMarker) {
          await assertPending();
        } else if (await optionalModelFile({ directory, name: pendingName })) {
          lostOwnership = true;
          throw new Error('Another operation created the pending marker');
        }
        const value = pendingDownloadSchema.parse(pending);
        ownedMarker = await writeModelMarkerJson({ directory, name: pendingName, value });
        observedMarker = JSON.stringify(value);
      };
      if (pendingHandle) {
        const value = await readModelMarkerJson({ handle: pendingHandle });
        observedMarker = JSON.stringify(value);
        pending = readPendingDownload({ value });
        if (!sameSource({ a: pending.source, b: file })) {
          throw new Error('Another download owns this pending file; existing data was preserved');
        }
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
        switch (validation) {
        case 'model-weight': await assertWeights({ file: snapshot, signal });
          break;
        case 'none': break;
        default: {
          const exhaustive: never = validation;
          throw new Error(String(exhaustive));
        }
        }
        signal.throwIfAborted();
        await publishModelFile({ directory, name, handle, file: snapshot, source: sourceReceipt({ file }) });
        return;
      }
      if (!pending) {
        pending = { version: 2, kind: 'naidan-file-download', source: file, bytes: 0, state: 'partial' };
        await writePending();
      }
      if (!handle) {
        if (pending.bytes !== 0) {
          throw new Error('Pending model file is missing; its journal was preserved');
        }
        handle = await directory.getFileHandle(name, { create: true });
        if ((await handle.getFile()).size !== 0) {
          throw new Error('Model destination changed during creation');
        }
      }
      await assertPending();
      // A crash may leave both markers. Pending continues to suppress the file
      // until this exact source is verified and its receipt is republished.
      if (await optionalModelFile({ directory, name: completeName })) {
        await directory.removeEntry(completeName);
      }
      let access: ModelDownloadAccess | undefined;
      let received = pending.bytes, processed = 0, checkpointBytes = pending.bytes;
      let hash: Sha256Hasher = createSha256Hasher();
      const yieldIfDue = createYieldPoint();
      let body: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
      let succeeded = false;
      const checkpoint = async (): Promise<void> => {
        if (!access) {
          return;
        }
        await assertPending();
        await access.flush();
        pending!.bytes = received;
        await writePending();
        checkpointBytes = received;
      };
      const abortRead = (): void => {
        void reader?.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', abortRead, { once: true });
      try {
        await assertPending();
        access = await openModelDownloadAccess({ handle, kind: target.kind, offset: received });
        const actual = access.getSize();
        if (actual < pending.bytes || actual > file.size) {
          throw new Error('Pending model differs from its journal; preserved without overwrite');
        }
        switch (pending.state) {
        case 'partial': break;
        case 'invalid': {
          received = 0;
          pending.bytes = 0;
          pending.state = 'partial';
          // This is an explicit retry of our failed download, not an existing
          // user file. Persist the restart intent before removing its bad bytes.
          await writePending();
          break;
        }
        default: {
          const exhaustive: never = pending.state;
          throw new Error(String(exhaustive));
        }
        }
        await access.truncate({ size: received });
        const buffer = new Uint8Array(chunkBytes);
        for (let offset = 0; offset < received; offset += chunkBytes) {
          signal.throwIfAborted();
          const bytes = buffer.subarray(0, Math.min(chunkBytes, received - offset));
          if (await access.read({ bytes, at: offset }) !== bytes.length) {
            throw new Error('Short read in pending model prefix');
          }
          hash.update({ bytes });
          report({ progress: { phase: 'verifying', bytes: offset + bytes.length, processed } });
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
            received = start;
            hash = createSha256Hasher();
            await access.truncate({ size: start });
            switch (access.checkpointMode) {
            case 'periodic': await checkpoint();
              break;
            case 'on-close': break;
            default: {
              const exhaustive: never = access.checkpointMode;
              throw new Error(String(exhaustive));
            }
            }
          }
          report({ progress: { phase: 'transferring', bytes: received, processed } });
          reader = body.getReader();
          while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) {
              break;
            }
            if (value.length > file.size - received) {
              throw new Error('Download exceeds expected size');
            }
            for (let offset = 0; offset < value.length; offset += chunkBytes) {
              signal.throwIfAborted();
              const bytes = value.subarray(offset, offset + chunkBytes);
              const count = await access.write({ bytes, at: received });
              if (count !== bytes.length) {
                throw new Error('Incomplete model storage write');
              }
              hash.update({ bytes });
              received += count;
              processed += count;
              if (access.checkpointMode === 'periodic' && received - checkpointBytes >= 16 * 1024 * 1024) {
                await checkpoint();
              }
              report({ progress: { phase: 'transferring', bytes: received, processed } });
              // Let abort messages reach this Worker during cached/local streams.
              await yieldIfDue();
            }
          }
        }
        if (received !== file.size) {
          throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
        }
        report({ progress: { phase: 'verifying', bytes: received, processed } });
        if (hash.digestHex() !== file.sha256) {
          pending.state = 'invalid';
          throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
        }
        signal.throwIfAborted();
        await checkpoint();
        await access.close();
        access = undefined;
        const snapshot = await handle.getFile();
        if (snapshot.size !== file.size) {
          throw new Error('Stored model size mismatch');
        }
        switch (validation) {
        case 'model-weight': await assertWeights({ file: snapshot, signal });
          break;
        case 'none': break;
        default: {
          const exhaustive: never = validation;
          throw new Error(String(exhaustive));
        }
        }
        await assertPending();
        await publishModelFile({ directory, name, handle, file: snapshot, source: sourceReceipt({ file }) });
        signal.throwIfAborted();
        // The sole publication point. A failure above retains pending, even if
        // writing the complete receipt itself was interrupted.
        await assertPending();
        await directory.removeEntry(pendingName);
        succeeded = true;
      } finally {
        signal.removeEventListener('abort', abortRead);
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        } else {
          await body?.cancel().catch(() => undefined);
        }
        try {
          if (!succeeded && !lostOwnership) {
            await checkpoint();
          }
        } finally {
          if (lostOwnership) {
            await access?.abort();
          } else {
            await access?.close();
          }
        }
      }
    },
  });
}

export const TEST_ONLY = {
  hashFile,
  pendingSchema: pendingDownloadSchema,
};
