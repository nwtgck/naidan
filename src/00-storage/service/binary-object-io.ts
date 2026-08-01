export type StorageBinaryObjectWriteSource =
  | {
      readonly type: 'direct_blob';

      /**
       * The Blob must already be directly available without reading,
       * decrypting, decompressing, or copying the complete payload.
       *
       * A Blob materialized from a stream or reader must never use this branch.
       */
      readonly blob: Blob;
    }
  | {
      readonly type: 'stream';
      readonly stream: ReadableStream<Uint8Array>;
    };

const BLOB_STREAM_FALLBACK_CHUNK_SIZE = 1024 * 1024;

export type StorageBinaryObjectReadBacking =
  | {
      type: 'direct_blob',

      /**
       * The Blob must be obtainable without reading, decrypting,
       * decompressing, or copying the complete payload.
       *
       * A materialized Blob created from a reader must never be exposed
       * through this branch.
       */
      blob: Blob,
    }
  | {
      type: 'reader_only',
    };

export interface StorageBinaryObjectReadHandle {
  readonly size: number,
  readonly mimeType: string,
  readonly backing: StorageBinaryObjectReadBacking,

  read({ buffer, offset, length, position, signal }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
    signal: AbortSignal | undefined,
  }): Promise<{ bytesRead: number }>,

  stream({ start, end, signal }: {
    start: number,
    end: number | undefined,
    signal: AbortSignal | undefined,
  }): ReadableStream<Uint8Array>,

  close(): Promise<void>,
}

export function createBlobStorageBinaryObjectReadHandle({
  blob,
  mimeType,
}: {
  blob: Blob,
  mimeType: string,
}): StorageBinaryObjectReadHandle {
  const directBlob = blob.type === mimeType
    ? blob
    : blob.slice(0, blob.size, mimeType);

  return {
    size: directBlob.size,
    mimeType,
    backing: {
      type: 'direct_blob',
      blob: directBlob,
    },
    async read({ buffer, offset, length, position, signal }) {
      signal?.throwIfAborted();
      const end = Math.min(position + length, directBlob.size);
      if (end <= position || length <= 0) {
        return { bytesRead: 0 };
      }

      const bytes = new Uint8Array(await directBlob.slice(position, end).arrayBuffer());
      signal?.throwIfAborted();
      const bytesRead = Math.min(bytes.byteLength, buffer.byteLength - offset);
      buffer.set(bytes.subarray(0, bytesRead), offset);
      return { bytesRead };
    },
    stream({ start, end, signal }) {
      signal?.throwIfAborted();
      return openBlobReadableStream({
        blob: directBlob,
        start,
        end,
        signal,
      });
    },
    async close() {},
  };
}


export function openBlobReadableStream({
  blob,
  start,
  end,
  signal,
}: {
  blob: Blob,
  start: number,
  end: number | undefined,
  signal: AbortSignal | undefined,
}): ReadableStream<Uint8Array> {
  signal?.throwIfAborted();
  const slicedBlob = blob.slice(start, end);
  const streamMethod = (slicedBlob as Blob & {
    stream?: () => ReadableStream<Uint8Array>,
  }).stream;
  if (typeof streamMethod === 'function') {
    const stream = streamMethod.call(slicedBlob);
    return signal === undefined
      ? stream
      : createAbortableReadableStream({ source: stream, signal });
  }

  let position = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        if (position >= slicedBlob.size) {
          controller.close();
          return;
        }

        const nextPosition = Math.min(
          position + BLOB_STREAM_FALLBACK_CHUNK_SIZE,
          slicedBlob.size,
        );
        const bytes = new Uint8Array(
          await slicedBlob.slice(position, nextPosition).arrayBuffer(),
        );
        signal?.throwIfAborted();
        position = nextPosition;
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function openStorageBinaryObjectWriteSourceStream({
  source,
}: {
  source: StorageBinaryObjectWriteSource,
}): ReadableStream<Uint8Array> {
  switch (source.type) {
  case 'direct_blob':
    return openBlobReadableStream({
      blob: source.blob,
      start: 0,
      end: undefined,
      signal: undefined,
    });
  case 'stream':
    return source.stream;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled binary object write source: ${String(_ex)}`);
  }
  }
}

export async function materializeStorageBinaryObjectWriteSourceAsBlob({
  source,
  mimeType,
}: {
  source: StorageBinaryObjectWriteSource,
  mimeType: string,
}): Promise<Blob> {
  switch (source.type) {
  case 'direct_blob':
    return source.blob.type === mimeType
      ? source.blob
      : source.blob.slice(0, source.blob.size, mimeType);
  case 'stream':
    return await new Response(source.stream, {
      headers: { 'content-type': mimeType },
    }).blob();
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled binary object write source: ${String(_ex)}`);
  }
  }
}

/**
 * A read operation may fail independently from releasing its temporary read
 * handle. Both failures are required to diagnose the unusable read without
 * losing the cleanup failure that also occurred.
 */
export async function runWithStorageBinaryObjectReadHandleClose<T>({
  handle,
  operation,
}: {
  handle: StorageBinaryObjectReadHandle;
  operation: () => Promise<T>;
}): Promise<T> {
  let operationFailure: { readonly cause: unknown } | undefined;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (cause: unknown) {
    operationFailure = { cause };
  }

  try {
    await handle.close();
  } catch (closeFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError(
        [operationFailure.cause, closeFailure],
        'Storage binary object read and handle cleanup both failed',
      );
    }
    throw closeFailure;
  }

  if (operationFailure !== undefined) throw operationFailure.cause;
  return value as T;
}

export async function materializeStorageBinaryObjectAsBlob({
  handle,
}: {
  handle: StorageBinaryObjectReadHandle,
}): Promise<Blob> {
  switch (handle.backing.type) {
  case 'direct_blob':
    return handle.backing.blob;
  case 'reader_only':
    return await new Response(handle.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    }), {
      headers: { 'content-type': handle.mimeType },
    }).blob();
  default: {
    const _ex: never = handle.backing;
    throw new Error(`Unhandled binary object read backing: ${String(_ex)}`);
  }
  }
}

function createAbortableReadableStream({
  source,
  signal,
}: {
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
}): ReadableStream<Uint8Array> {
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the original abort or read error.
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
