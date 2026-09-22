import { createWeshOwnedBytes } from '@/features/wesh/types';
import type {
  WeshOpenFlags,
  WeshFileHandle,
  WeshEfficientFileWriteResult,
  WeshEfficientFileWriter,
  WeshEfficientBlobReadResult,
} from '@/features/wesh/types';

type FileOperationFailure = { error: unknown };

/** Each cleanup owns a distinct resource. Start them all, even if one rejects. */
async function withFileCleanup<T>({ operation, cleanup }: {
  operation: () => Promise<T>,
  cleanup: readonly (({ failure }: { failure: FileOperationFailure | undefined }) => Promise<void>)[],
}): Promise<T> {
  const outcome = await Promise.resolve().then(operation).then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  const failure = (() => {
    switch (outcome.status) {
    case 'fulfilled': return undefined;
    case 'rejected': return { error: outcome.error };
    default: { const _ex: never = outcome; throw new Error(`Unhandled file outcome: ${String(_ex)}`); }
    }
  })();
  const errors = failure === undefined ? [] : [failure.error];
  const results = await Promise.allSettled(cleanup.map(run => Promise.resolve().then(() => run({ failure }))));
  for (const result of results) {
    switch (result.status) {
    case 'fulfilled': break;
    case 'rejected':
      // Cancelling an already-errored stream can reject with the original error.
      if (!errors.includes(result.reason)) errors.push(result.reason);
      break;
    default: { const _ex: never = result; throw new Error(`Unhandled cleanup outcome: ${String(_ex)}`); }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'File operation and cleanup failed');
  switch (outcome.status) {
  case 'fulfilled': return outcome.value;
  case 'rejected': throw outcome.error;
  default: { const _ex: never = outcome; throw new Error(`Unhandled file outcome: ${String(_ex)}`); }
  }
}

function assertReadCount({ bytesRead, length }: { bytesRead: number, length: number }): void {
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
    throw new Error('File handle returned an invalid read count');
  }
}

async function releaseInputReader({ reader, completed, failure }: {
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  completed: boolean,
  failure: FileOperationFailure | undefined,
}): Promise<void> {
  if (reader === undefined) return;
  try {
    if (!completed) await reader.cancel(failure?.error);
  } finally {
    reader.releaseLock();
  }
}

/** writeOwned consumes the whole chunk by contract; ordinary writes may be short. */
async function writeHandleChunk({ handle, bytes }: { handle: WeshFileHandle, bytes: Uint8Array }): Promise<void> {
  if (bytes.byteLength === 0) return;
  if (handle.writeOwned !== undefined) {
    await handle.writeOwned({ chunk: createWeshOwnedBytes({ bytes }) });
  } else {
    await writeAllBytesToHandle({ handle, data: bytes });
  }
}

/**
 * Read all remaining bytes from a sequential file handle without closing it.
 *
 * This is intended for shared descriptors such as stdin, where later reads
 * must observe the consumed offset rather than reopening or rewinding input.
 */
export async function readAllHandleBytes({
  handle,
}: {
  handle: WeshFileHandle,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const buffer = new Uint8Array(64 * 1024);
    const { bytesRead } = await handle.read({ buffer });
    assertReadCount({ bytesRead, length: buffer.byteLength });
    if (bytesRead === 0) break;
    if (bytesRead > Number.MAX_SAFE_INTEGER - totalLength) throw new RangeError('File content is too large');

    const chunk = bytesRead === buffer.byteLength ? buffer : buffer.slice(0, bytesRead);
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }

  if (chunks.length === 1) return chunks[0]!;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

interface WeshFileCapabilities {
  open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }): Promise<WeshFileHandle>,
  stat({ path }: { path: string }): Promise<unknown>,
  tryReadBlobEfficiently?({ path }: { path: string }): Promise<WeshEfficientBlobReadResult>,
  tryCreateFileWriterEfficiently?({ path, mode }: {
    path: string,
    mode: 'truncate' | 'append',
  }): Promise<WeshEfficientFileWriteResult>,
}

/**
 * Read the entire content of a file as a Uint8Array.
 */
export async function readAllFileBytes({ files, path }: { files: WeshFileCapabilities, path: string }): Promise<Uint8Array> {
  if (files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob_view':
      return blobResult.blob.bytes();
    case 'blob':
      return new Uint8Array(await blobResult.blob.arrayBuffer());
    case 'fallback_required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await files.open({ path, flags });
  return withFileCleanup({
    // stat.size may be an estimate. Only actual EOF completes an all-bytes read.
    operation: () => readAllHandleBytes({ handle }),
    cleanup: [() => handle.close()],
  });
}

/**
 * Read the entire content of a file as a UTF-8 string.
 */
export async function readAllFileText({ files, path }: { files: WeshFileCapabilities, path: string }): Promise<string> {
  if (files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob_view':
    case 'blob':
      return blobResult.blob.text();
    case 'fallback_required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return new TextDecoder().decode(await readAllFileBytes({ files, path }));
}

/**
 * Open a file as a ReadableStream<Uint8Array>, using blob-backed streaming when available.
 */
export async function openFileReadStream({
  files,
  path,
}: {
  files: WeshFileCapabilities,
  path: string,
}): Promise<ReadableStream<Uint8Array>> {
  if (files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob_view':
      return blobResult.blob.stream();
    case 'blob':
      return blobResult.blob.stream() as ReadableStream<Uint8Array>;
    case 'fallback_required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const flags: WeshOpenFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  };
  const handle = await files.open({ path, flags });
  return openHandleReadStream({ handle });
}

export async function writeAllBytesToHandle({
  handle,
  data,
}: {
  handle: WeshFileHandle,
  data: Uint8Array,
}): Promise<void> {
  let totalWritten = 0;
  while (totalWritten < data.byteLength) {
    const length = data.byteLength - totalWritten;
    const { bytesWritten } = await handle.write({ buffer: data, offset: totalWritten, length });
    // Zero progress is not success for a write-all operation. Negative/fractional
    // or overlong counts must not skip data or move the loop backwards either.
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > length) {
      throw new Error('File handle did not make valid write progress');
    }
    totalWritten += bytesWritten;
  }
}

/**
 * Write the entire content of a Uint8Array to a file.
 */
export async function writeAllFileBytes({
  files,
  path,
  data,
}: {
  files: WeshFileCapabilities,
  path: string,
  data: Uint8Array,
}): Promise<void> {
  const flags: WeshOpenFlags = {
    access: 'write',
    creation: 'if-needed',
    truncate: 'truncate',
    append: 'preserve',
  };
  const handle = await files.open({ path, flags });
  await withFileCleanup({
    operation: () => writeAllBytesToHandle({ handle, data }),
    cleanup: [() => handle.close()],
  });
}

/**
 * Check if a file or directory exists.
 */
export async function checkFileExists({ files, path }: { files: WeshFileCapabilities, path: string }): Promise<boolean> {
  try {
    await files.stat({ path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a WeshFileHandle to a ReadableStream<Uint8Array>.
 */
export function openHandleReadStream({
  handle,
  chunkSize,
}: {
  handle: WeshFileHandle,
  chunkSize?: number,
}): ReadableStream<Uint8Array> {
  const length = chunkSize ?? 64 * 1024;
  // Validation precedes ownership transfer. Invalid options must not consume or
  // close a handle that the caller can still use for another operation.
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError('Invalid file stream chunk size');
  let stopped = false;
  const isStopped = () => stopped;
  let closing: Promise<void> | undefined;
  function closeOnce(): Promise<void> {
    closing ??= Promise.resolve().then(() => handle.close());
    return closing;
  }
  return new ReadableStream({
    async pull(controller) {
      if (isStopped()) return;
      try {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read({ buffer });
        if (isStopped()) return;
        assertReadCount({ bytesRead, length });
        if (bytesRead === 0) {
          await closeOnce();
          if (isStopped()) return;
          stopped = true;
          controller.close();
          return;
        }
        controller.enqueue(bytesRead === buffer.length ? buffer : buffer.slice(0, bytesRead));
      } catch (error) {
        // cancel() already owns cleanup. A late read result/rejection must not
        // enqueue into the closed stream or close a non-idempotent handle twice.
        if (isStopped()) return;
        let failure = error;
        try {
          await closeOnce();
        } catch (closeError) {
          if (closeError !== error) failure = new AggregateError([error, closeError], 'File read and close failed');
        }
        if (!isStopped()) {
          stopped = true;
          controller.error(failure);
        }
      }
    },
    cancel() {
      stopped = true;
      return closeOnce();
    },
  }, { highWaterMark: 0 });
}

/**
 * Write a ReadableStream<Uint8Array> to a WeshFileHandle.
 */
export async function writeAllStreamToHandle({
  stream,
  handle,
  closeHandle,
}: {
  stream: ReadableStream<Uint8Array>,
  handle: WeshFileHandle,
  closeHandle: boolean,
}): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  await withFileCleanup({
    async operation() {
      reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true; return;
        }
        await writeHandleChunk({ handle, bytes: value });
      }
    },
    cleanup: [
      ({ failure }) => releaseInputReader({ reader, completed, failure }),
      async () => {
        // A generic handle has no abort API: closing it can publish a partial
        // prefix. Reject the copy, but do not pretend to roll back that prefix.
        if (closeHandle) await handle.close();
      },
    ],
  });
}

export async function writeAllStreamToFile({
  files,
  path,
  stream,
  mode,
}: {
  files: WeshFileCapabilities,
  path: string,
  stream: ReadableStream<Uint8Array>,
  mode: 'truncate' | 'append',
}): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let writer: WeshEfficientFileWriter | undefined;
  let committed = false;
  let handle: WeshFileHandle | undefined;
  await withFileCleanup({
    async operation() {
      // Acquire the input before creating/truncating a destination. A stream
      // already locked by somebody else must not leak a writer or destroy data.
      reader = stream.getReader();
      const efficientWriterResult = files.tryCreateFileWriterEfficiently === undefined
        ? undefined
        : await files.tryCreateFileWriterEfficiently({ path, mode });
      switch (efficientWriterResult?.kind) {
      case 'writer':
        writer = efficientWriterResult.writer;
        break;
      case 'fallback_required':
      case undefined: {
        const flags = (() => {
          switch (mode) {
          case 'truncate':
            return { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' } satisfies WeshOpenFlags;
          case 'append':
            return { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' } satisfies WeshOpenFlags;
          default: { const _ex: never = mode; throw new Error(`Unhandled stream-to-path mode: ${_ex}`); }
          }
        })();
        handle = await files.open({ path, flags });
        break;
      }
      default: {
        const _ex: never = efficientWriterResult;
        throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
      }
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true; break;
        }
        if (value.byteLength === 0) continue;
        if (writer !== undefined) await writer.write({ chunk: value });
        else if (handle !== undefined) await writeHandleChunk({ handle, bytes: value });
        else throw new Error('File writer is unavailable');
      }
      if (writer !== undefined) {
        await writer.close();
        committed = true;
      }
    },
    cleanup: [
      ({ failure }) => releaseInputReader({ reader, completed, failure }),
      async ({ failure }) => {
        if (writer !== undefined && !committed) await writer.abort({ reason: failure?.error });
        if (handle !== undefined) await handle.close();
      },
    ],
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
