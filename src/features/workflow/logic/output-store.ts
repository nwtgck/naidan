import { generateId } from '@/01-models/id';
import { idToRaw, type WorkflowOutputId } from '@/01-models/ids';

export type WorkflowOutputLimits = {
  maxEntries: number,
  maxBytes: number,
  maxOutputBytes: number,
  maxPendingWriteBytes: number,
  maxWriteChunkBytes: number,
  readChunkBytes: number,
  maxReaders: number,
};

export type WorkflowOutput = {
  readonly byteLength: number,
  retain: () => WorkflowOutput,
  openStream: ({ signal }: { signal: AbortSignal | undefined }) => ReadableStream<Uint8Array>,
  release: () => Promise<void>,
};

export type WorkflowOutputWriter = {
  write: ({ chunk }: { chunk: Uint8Array }) => Promise<void>,
  seal: () => Promise<WorkflowOutput>,
  abort: ({ reason }: { reason: unknown }) => Promise<void>,
};

export type WorkflowOutputStore = {
  createWriter: ({ signal }: { signal: AbortSignal | undefined }) => Promise<WorkflowOutputWriter>,
  getUsage: () => { entries: number, bytes: number, pendingWriteBytes: number, readers: number },
  close: () => Promise<void>,
};

type Entry = {
  id: WorkflowOutputId,
  name: string,
  status: 'opening' | 'writing' | 'sealing' | 'sealed' | 'failed' | 'released',
  handle: FileSystemFileHandle | undefined,
  writable: FileSystemWritableFileStream | undefined,
  writableStatus: 'absent' | 'open' | 'closed' | 'aborted',
  file: File | undefined,
  bytes: number,
  owners: number,
  readers: Set<OutputReader>,
  active: Promise<unknown> | undefined,
  cleanup: Promise<void> | undefined,
  failure: unknown,
  detachProducer: () => void,
};

type OutputReader = {
  stop: ({ reason }: { reason: unknown }) => Promise<void>,
};

function outputError({ message }: { message: string }): Error {
  return new Error(`Workflow output: ${message}`);
}

/**
 * Runtime-owned, replayable bytes, not persisted Workflow records or user files.
 * The caller supplies an exclusively owned temporary directory (normally from
 * getOPFSTmpManager). Never pass a user-selected Volume directory here.
 *
 * Production cancellation stops only unsealed outputs. Sealed outputs have
 * independent leases and read signals, so completed results remain exportable
 * after a run stops. One runtime can share the store across retained runs to
 * keep their aggregate budget bounded. Closing it, unlike stopping a run,
 * revokes every output, including leases retained by result views.
 */
export function createWorkflowOutputStore({ directory, limits }: {
  directory: FileSystemDirectoryHandle,
  limits: WorkflowOutputLimits,
}): WorkflowOutputStore {
  // Capture policy, rather than observing later UI changes during writes.
  const { maxEntries, maxBytes, maxOutputBytes, maxPendingWriteBytes, maxWriteChunkBytes, readChunkBytes, maxReaders, ...unhandled } = limits;
  unhandled satisfies Record<PropertyKey, never>;
  for (const limit of [maxEntries, maxBytes, maxOutputBytes, maxPendingWriteBytes, maxWriteChunkBytes, readChunkBytes, maxReaders]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw outputError({ message: 'Limits must be positive safe integers.' });
    }
  }
  const entries = new Map<WorkflowOutputId, Entry>();
  let status: 'open' | 'closing' | 'closed' = 'open';
  let bytes = 0, pendingWriteBytes = 0, readers = 0;
  let closeTask: Promise<void> | undefined;

  function assertOpen(): void {
    switch (status) {
    case 'open': return;
    case 'closing':
    case 'closed': throw outputError({ message: 'The store is closed.' });
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled store status: ${_ex}`);
    }
    }
  }

  function failEntry({ entry, reason }: { entry: Entry, reason: unknown }): void {
    if (entry.status === 'sealed' || entry.status === 'released' || entry.status === 'failed') {
      return;
    }
    entry.status = 'failed';
    entry.failure = reason;
    entry.detachProducer();
  }

  async function cleanEntry({ entry }: { entry: Entry }): Promise<void> {
    if (!entries.has(entry.id)) {
      return;
    }
    if (entry.cleanup) {
      return entry.cleanup;
    }
    const task = (async () => {
      // Native file operations are not forcibly interruptible. Do not publish
      // cancellation as completed cleanup while a write or close still runs.
      await entry.active?.catch(() => undefined);
      if (entry.readers.size > 0 || (status === 'open' && entry.status === 'sealed' && entry.owners > 0)) {
        return;
      }
      entry.detachProducer();
      entry.status = 'released';
      if (entry.writable && entry.writableStatus === 'open') {
        await entry.writable.abort(entry.failure);
        entry.writableStatus = 'aborted';
      }
      try {
        await directory.removeEntry(entry.name);
      } catch (error) {
        if (!((error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError')) {
          throw error;
        }
      }
      entries.delete(entry.id);
      bytes -= entry.bytes;
      entry.file = undefined;
      entry.handle = undefined;
      entry.writable = undefined;
    })();
    entry.cleanup = task;
    try {
      await task;
    } finally {
      entry.cleanup = undefined;
    }
  }

  function observeCleanup({ entry }: { entry: Entry }): void {
    // A failed deletion stays charged to the store and is retried by close().
    // Observe this background rejection; explicit release/close still report it.
    void cleanEntry({ entry }).catch(() => undefined);
  }

  function cleanFailedEntry({ entry }: { entry: Entry }): void {
    switch (entry.status) {
    case 'failed': observeCleanup({ entry });
      return;
    case 'opening':
    case 'writing':
    case 'sealing':
    case 'sealed':
    case 'released': return;
    default: {
      const _ex: never = entry.status;
      throw new Error(`Unhandled output status: ${_ex}`);
    }
    }
  }

  function assertWriting({ entry }: { entry: Entry }): void {
    assertOpen();
    switch (entry.status) {
    case 'writing':
      if (entry.active) {
        throw outputError({ message: 'The writer is busy.' });
      }
      return;
    case 'failed': throw entry.failure;
    case 'opening':
    case 'sealing':
    case 'sealed':
    case 'released': throw outputError({ message: 'The writer is not writable.' });
    default: {
      const _ex: never = entry.status;
      throw new Error(`Unhandled output status: ${_ex}`);
    }
    }
  }

  function makeLease({ entry }: { entry: Entry }): WorkflowOutput {
    let leaseStatus: 'active' | 'released' = 'active';
    entry.owners++;
    function assertLease(): void {
      assertOpen();
      if (leaseStatus !== 'active' || entry.status !== 'sealed' || !entry.file) {
        throw outputError({ message: 'The output lease has been released.' });
      }
    }
    return Object.freeze({
      byteLength: entry.bytes,
      retain() {
        assertLease();
        return makeLease({ entry });
      },
      openStream({ signal }: { signal: AbortSignal | undefined }) {
        assertLease();
        signal?.throwIfAborted();
        if (readers >= maxReaders) {
          throw outputError({ message: 'Reader limit exceeded.' });
        }
        const file = entry.file;
        if (!file) {
          throw outputError({ message: 'The output has no sealed file.' });
        }
        let readerStatus: 'open' | 'closed' = 'open';
        let position = 0;
        let pending: Promise<ArrayBuffer> | undefined;
        let finishing: Promise<void> | undefined;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

        function isReaderOpen(): boolean {
          switch (readerStatus) {
          case 'open': return true;
          case 'closed': return false;
          default: {
            const _ex: never = readerStatus;
            throw new Error(`Unhandled reader status: ${_ex}`);
          }
          }
        }
        function finish(): Promise<void> {
          if (finishing) {
            return finishing;
          }
          readerStatus = 'closed';
          signal?.removeEventListener('abort', onAbort);
          finishing = (async () => {
            await pending?.catch(() => undefined);
            entry.readers.delete(reader);
            readers--;
            if (entry.owners === 0 || status !== 'open') {
              await cleanEntry({ entry });
            }
          })();
          return finishing;
        }
        function onAbort(): void {
          void reader.stop({ reason: signal?.reason }).catch(() => undefined);
        }
        const reader: OutputReader = {
          async stop({ reason }) {
            if (isReaderOpen()) {
              controller?.error(reason);
            }
            await finish();
          },
        };
        entry.readers.add(reader);
        readers++;
        return new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
              onAbort();
            }
          },
          async pull(value) {
            if (!isReaderOpen()) {
              return;
            }
            if (position === entry.bytes) {
              value.close();
              await finish();
              return;
            }
            const end = Math.min(position + readChunkBytes, entry.bytes);
            try {
              pending = file.slice(position, end).arrayBuffer();
              const buffer = await pending;
              pending = undefined;
              // Cancellation may have happened during the non-abortable read.
              if (!isReaderOpen()) {
                return;
              }
              if (buffer.byteLength !== end - position) {
                throw outputError({ message: 'The sealed output changed or was truncated.' });
              }
              position = end;
              value.enqueue(new Uint8Array(buffer));
            } catch (error) {
              pending = undefined;
              await reader.stop({ reason: error });
            }
          },
          async cancel() {
            await finish();
          },
        }, { highWaterMark: 0 });
      },
      async release() {
        switch (leaseStatus) {
        case 'released': return;
        case 'active': break;
        default: {
          const _ex: never = leaseStatus;
          throw new Error(`Unhandled output lease status: ${_ex}`);
        }
        }
        leaseStatus = 'released';
        entry.owners--;
        if (entry.owners === 0 && entry.readers.size === 0) {
          await cleanEntry({ entry });
        }
      },
    });
  }

  async function createWriter({ signal }: { signal: AbortSignal | undefined }): Promise<WorkflowOutputWriter> {
    assertOpen();
    signal?.throwIfAborted();
    if (entries.size >= maxEntries) {
      throw outputError({ message: 'Output count limit exceeded.' });
    }
    const id = generateId<WorkflowOutputId>();
    if (entries.has(id)) {
      throw outputError({ message: 'Output ID collision.' });
    }
    const entry: Entry = {
      id,
      name: `output-${idToRaw({ id })}`,
      status: 'opening',
      handle: undefined,
      writable: undefined,
      writableStatus: 'absent',
      file: undefined,
      bytes: 0,
      owners: 0,
      readers: new Set(),
      active: undefined,
      cleanup: undefined,
      failure: undefined,
      detachProducer: () => signal?.removeEventListener('abort', onAbort),
    };
    entries.set(id, entry);
    function onAbort(): void {
      failEntry({ entry, reason: signal?.reason ?? outputError({ message: 'Production cancelled.' }) });
      observeCleanup({ entry });
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    function checkProduction(): void {
      assertOpen();
      if (entry.status === 'failed' || entry.status === 'released') {
        throw entry.failure ?? outputError({ message: 'Production cancelled.' });
      }
      signal?.throwIfAborted();
    }

    async function perform<T>({ action }: { action: () => Promise<T> }): Promise<T> {
      const task = action();
      entry.active = task;
      try {
        return await task;
      } catch (error) {
        failEntry({ entry, reason: error });
        throw error;
      } finally {
        entry.active = undefined;
        cleanFailedEntry({ entry });
      }
    }

    await perform({
      action: async () => {
        entry.handle = await directory.getFileHandle(entry.name, { create: true });
        checkProduction();
        entry.writable = await entry.handle.createWritable();
        entry.writableStatus = 'open';
        checkProduction();
        entry.status = 'writing';
      },
    });

    // Keep the asynchronous closure outside write() so it cannot capture the
    // caller's potentially much larger backing ArrayBuffer through that scope.
    function writeOwned({ owned, size }: { owned: Uint8Array<ArrayBuffer>, size: number }): Promise<void> {
      return perform({
        action: async () => {
          try {
            const writable = entry.writable;
            if (!writable) {
              throw outputError({ message: 'The writer has no file.' });
            }
            await writable.write(owned.buffer);
            checkProduction();
          } finally {
            pendingWriteBytes -= size;
          }
        },
      });
    }

    // The non-async front end snapshots an accepted chunk before returning.
    // Its async operation retains only that bounded copy, not a huge backing
    // ArrayBuffer or a producer buffer that may be reused after write().
    function write({ chunk }: { chunk: Uint8Array }): Promise<void> {
      try {
        assertWriting({ entry });
        const size = chunk.byteLength;
        if (size > maxWriteChunkBytes || size > maxPendingWriteBytes - pendingWriteBytes) {
          throw outputError({ message: 'Pending write or chunk limit exceeded.' });
        }
        if (size > maxBytes - bytes || size > maxOutputBytes - entry.bytes) {
          throw outputError({ message: 'Output byte limit exceeded.' });
        }
        const owned = Uint8Array.from(chunk);
        entry.bytes += size;
        bytes += size;
        pendingWriteBytes += size;
        return writeOwned({ owned, size });
      } catch (error) {
        // A rejected chunk must not later be published as a successful prefix.
        failEntry({ entry, reason: error });
        cleanFailedEntry({ entry });
        return Promise.reject(error);
      }
    }

    return {
      write,
      async seal() {
        assertWriting({ entry });
        entry.status = 'sealing';
        return perform({
          action: async () => {
            if (!entry.writable || !entry.handle) {
              throw outputError({ message: 'The writer has no file.' });
            }
            await entry.writable.close();
            entry.writableStatus = 'closed';
            checkProduction();
            entry.file = await entry.handle.getFile();
            checkProduction();
            if (entry.file.size !== entry.bytes) {
              throw outputError({ message: 'The committed output has the wrong size.' });
            }
            entry.status = 'sealed';
            entry.detachProducer();
            return makeLease({ entry });
          },
        });
      },
      async abort({ reason }) {
        switch (entry.status) {
        case 'sealed': throw outputError({ message: 'Release sealed output leases instead of aborting production.' });
        case 'opening':
        case 'writing':
        case 'sealing':
        case 'failed':
        case 'released': break;
        default: {
          const _ex: never = entry.status;
          throw new Error(`Unhandled output status: ${_ex}`);
        }
        }
        failEntry({ entry, reason });
        await cleanEntry({ entry });
      },
    };
  }

  function close(): Promise<void> {
    if (closeTask) {
      return closeTask;
    }
    status = 'closing';
    const reason = outputError({ message: 'The store is closed.' });
    const task = (async () => {
      const failures: unknown[] = [];
      const closingEntries = [...entries.values()];
      const stops: Promise<void>[] = [];
      // Revoke all readers synchronously, even if the first native writer is
      // still settling. Cleanup latency must not leave later entries usable.
      for (const entry of closingEntries) {
        failEntry({ entry, reason });
        for (const reader of entry.readers) {
          stops.push(reader.stop({ reason }));
        }
      }
      const results = await Promise.allSettled(stops);
      for (const result of results) {
        switch (result.status) {
        case 'rejected': failures.push(result.reason);
          break;
        case 'fulfilled': break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled cleanup result: ${((_ex satisfies never) as { readonly status: string }).status}`);
        }
        }
      }
      for (const entry of closingEntries) {
        try {
          await cleanEntry({ entry });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to remove temporary Workflow outputs.');
      }
      status = 'closed';
    })();
    closeTask = task;
    // A failed cleanup can be retried, but never reopens the store for writes.
    void task.catch(() => {
      closeTask = undefined;
    });
    return task;
  }

  return {
    createWriter,
    getUsage: () => ({ entries: entries.size, bytes, pendingWriteBytes, readers }),
    close,
  };
}

export const TEST_ONLY = {
};
