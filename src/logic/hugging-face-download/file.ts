import { pendingDownloadSchema, readPendingDownload } from './pending';
import { createFileMoveSupportCache, moveStagedFile, temporaryFileName, type FileMoveSupportCache } from '@/utils/file-system-publication';
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

/** A new download uses its filename for the entire publication protocol:
 * `name.tmp` while writing and `name` after a successful move. There are no
 * new journal/receipt files. The pinned request supplies the expected hash;
 * an existing .tmp is a resumable prefix, not evidence of completed content.
 * This runs under the same repository mutation lock as the legacy writer.
 */
async function saveStagedHuggingFaceFile({ directory, name, staged, file, kind, signal, report, fetch, validation, moveSupport }: {
  directory: FileSystemDirectoryHandle, name: string, staged: FileSystemFileHandle | undefined,
  file: HuggingFaceFile, kind: 'opfs' | 'host', signal: AbortSignal,
  report: ({ progress }: { progress: FileTransferProgress }) => void, fetch: DownloadFetch,
  validation: 'model-weight' | 'none', moveSupport: FileMoveSupportCache,
}): Promise<void> {
  const temporaryName = temporaryFileName({ name });
  const handle = staged ?? await directory.getFileHandle(temporaryName, { create: true });
  const existing = await handle.getFile();
  if (existing.size > file.size) {
    throw new Error('Temporary download is larger than the pinned file; preserved without overwrite');
  }
  let restartCorruptTmp = false;
  if (existing.size === file.size) {
    const digest = await hashFile({ file: existing, signal, report: ({ bytes }) => report({ progress: { phase: 'verifying', bytes, processed: 0 } }) });
    if (digest === file.sha256) {
      switch (validation) {
      case 'model-weight': await assertWeights({ file: existing, signal });
        break;
      case 'none': break;
      default: {
        const exhaustive: never = validation;
        throw new Error(String(exhaustive));
      }
      }
      signal.throwIfAborted();
      await moveStagedFile({ directory, name, handle, snapshot: existing, moveSupport });
      return;
    }
    // The explicit retry may replace a corrupt .tmp, but never an existing
    // published file. Otherwise a failed full-length transfer is unrecoverable.
    restartCorruptTmp = true;
  }
  let access: ModelDownloadAccess | undefined;
  let received = restartCorruptTmp ? 0 : existing.size, processed = 0, checkpointBytes = received;
  let hash = createSha256Hasher();
  const yieldIfDue = createYieldPoint();
  let body: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const abortRead = (): void => {
    void reader?.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abortRead, { once: true });
  try {
    access = await openModelDownloadAccess({ handle, kind, offset: received });
    if (access.getSize() !== existing.size) {
      throw new Error('Temporary download changed before resuming');
    }
    if (restartCorruptTmp) {
      await access.truncate({ size: 0 });
    }
    const buffer = new Uint8Array(chunkBytes);
    for (let offset = 0; offset < received; offset += chunkBytes) {
      signal.throwIfAborted();
      const bytes = buffer.subarray(0, Math.min(chunkBytes, received - offset));
      if (await access.read({ bytes, at: offset }) !== bytes.length) {
        throw new Error('Short read in temporary model prefix');
      }
      hash.update({ bytes });
      report({ progress: { phase: 'verifying', bytes: offset + bytes.length, processed } });
      await yieldIfDue();
    }
    signal.throwIfAborted();
    const url = `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch({ request: { url, signal, ...(received ? { headers: [['Range', `bytes=${received}-`]] } : {}) } });
    body = response.body;
    const start = responseOffset({ status: response.status, headers: response.headers, offset: received, size: file.size });
    if (start !== received) {
      // An HTTP 200 to a Range request means restart from byte 0. The
      // caller explicitly requested this download; do not touch the final.
      received = start;
      hash = createSha256Hasher();
      await access.truncate({ size: start });
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
        const bytes = value.subarray(offset, offset + chunkBytes);
        const count = await access.write({ bytes, at: received });
        if (count !== bytes.length) {
          throw new Error('Incomplete model storage write');
        }
        hash.update({ bytes });
        received += count;
        processed += count;
        if (access.checkpointMode === 'periodic' && received - checkpointBytes >= 16 * 1024 * 1024) {
          await access.flush();
          checkpointBytes = received;
        }
        report({ progress: { phase: 'transferring', bytes: received, processed } });
        await yieldIfDue();
      }
    }
    if (received !== file.size || hash.digestHex() !== file.sha256) {
      throw new Error('Downloaded model size or SHA-256 does not match the pinned source');
    }
    report({ progress: { phase: 'verifying', bytes: received, processed } });
    signal.throwIfAborted();
    await access.flush();
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
    signal.throwIfAborted();
    await moveStagedFile({ directory, name, handle, snapshot, moveSupport });
  } finally {
    signal.removeEventListener('abort', abortRead);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else {
      await body?.cancel().catch(() => undefined);
    }
    // A graceful interruption commits the partial .tmp, especially on Host
    // FS where a writable stream publishes its bytes on close.
    await access?.close();
  }
}

/** Runs in a dedicated Worker. Pending bytes are never inference inputs, even
 * when their small GGUF header looks valid. Sync writes checkpoint after flush;
 * resume hashes the stored prefix before accepting any Range response suffix.
 */
export async function saveHuggingFaceFile({ file, signal, report, fetch, destination, expectedRoot, validation, moveSupport }: {
  fetch: DownloadFetch,
  moveSupport?: FileMoveSupportCache,
  file: HuggingFaceFile, signal: AbortSignal, report: ({ progress }: { progress: FileTransferProgress }) => void,
  destination?: DownloadDestination,
  expectedRoot: FileSystemDirectoryHandle | undefined,
  validation: 'model-weight' | 'none',
}): Promise<void> {
  file = huggingFaceFileSchema.parse(file);
  const target = destination ?? { kind: 'opfs' };
  const support = moveSupport ?? createFileMoveSupportCache();
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
      const final = await optionalModelFile({ directory, name });
      const staged = await optionalModelFile({ directory, name: temporaryFileName({ name }) });
      if (staged && final) {
        throw new Error('Both temporary and published model files exist; preserved without overwrite');
      }
      if (staged && pendingHandle) {
        throw new Error('Legacy journal conflicts with a temporary model file; preserved without overwrite');
      }
      if (!pendingHandle) {
        if (final) {
          // Old published files and new markerless publications use the same
          // exact-source verification; neither requires writing new metadata.
          const snapshot = await final.getFile();
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
          const current = await directory.getFileHandle(name);
          const now = await current.getFile();
          if (!await current.isSameEntry(final) || now.size !== snapshot.size || now.lastModified !== snapshot.lastModified) {
            throw new Error('Model changed during verification');
          }
          return;
        }
        const capability = await support.detect({ directory });
        switch (capability) {
        case 'supported':
          await saveStagedHuggingFaceFile({ directory, name, staged, file, kind: target.kind, signal, report, fetch, validation, moveSupport: support });
          return;
        case 'unsupported':
          if (staged) {
            throw new DOMException('Existing temporary model requires move support', 'NotSupportedError');
          }
          break;
        default: {
          const exhaustive: never = capability;
          throw new Error(String(exhaustive));
        }
        }
      }
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
