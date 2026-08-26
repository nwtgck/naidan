import {
  createWebZipCompressionCodec,
  iterateZipStreamChunks,
  StreamingZipWriter,
  type ZipCompression,
  type ZipByteSink,
  type ZipCentralDirectoryStore,
} from './index';

/**
 * Memory-backed adapters for browser-facing ZIP features.
 *
 * These adapters depend on the environment-independent ZIP core. The core must
 * never import this module. Keep that direction one-way so application-specific
 * buffering policy cannot leak into Wesh or the core codec.
 */

export function createMemoryZipCentralDirectoryStore(): ZipCentralDirectoryStore {
  let chunks: Uint8Array[] = [];
  let finalized = false;
  let disposed = false;

  function assertAvailable(): void {
    if (disposed) {
      throw new Error('ZIP central directory store is disposed');
    }
  }

  return {
    async write({ chunk }) {
      assertAvailable();
      if (finalized) {
        throw new Error('ZIP central directory store is finalized');
      }
      chunks.push(chunk);
    },
    async finalize() {
      assertAvailable();
      finalized = true;
    },
    async openStream() {
      assertAvailable();
      if (!finalized) {
        throw new Error('ZIP central directory store is not finalized');
      }
      const currentChunks = chunks;
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = currentChunks[index];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          index += 1;
          controller.enqueue(chunk);
        },
      });
    },
    async dispose() {
      disposed = true;
      chunks = [];
    },
  };
}

export function createReadableZipOutput({
  highWaterMarkBytes,
}: {
  highWaterMarkBytes: number,
}): {
  sink: ZipByteSink,
  stream: ReadableStream<Uint8Array>,
  close(): Promise<void>,
  abort({ reason }: { reason: unknown }): Promise<void>,
} {
  const transform = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: highWaterMarkBytes }),
    new ByteLengthQueuingStrategy({ highWaterMark: highWaterMarkBytes }),
  );
  const writer = transform.writable.getWriter();
  let completed = false;

  return {
    sink: {
      async write({ chunk }) {
        if (completed) {
          throw new Error('ZIP output is already completed');
        }
        await writer.write(chunk);
      },
    },
    stream: transform.readable,
    async close() {
      if (completed) {
        return;
      }
      completed = true;
      await writer.close();
    },
    async abort({ reason }) {
      if (completed) {
        return;
      }
      completed = true;
      await writer.abort(reason);
    },
  };
}

export async function createSingleFileZipBlob({
  fileName,
  bytes,
  modifiedAt,
  compression,
}: {
  fileName: string,
  bytes: Uint8Array,
  modifiedAt: Date,
  compression: ZipCompression,
}): Promise<Blob> {
  const output = createReadableZipOutput({ highWaterMarkBytes: 512 * 1024 });
  const centralDirectoryStore = createMemoryZipCentralDirectoryStore();
  const writer = new StreamingZipWriter({
    output: output.sink,
    centralDirectoryStore,
    compressionCodec: createWebZipCompressionCodec(),
  });
  const archiveChunksPromise = (async (): Promise<Uint8Array<ArrayBuffer>[]> => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of iterateZipStreamChunks({ stream: output.stream })) {
      const copy = new Uint8Array(new ArrayBuffer(chunk.byteLength));
      copy.set(chunk);
      chunks.push(copy);
    }
    return chunks;
  })();
  let emitted = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted) {
        controller.close();
        return;
      }
      emitted = true;
      controller.enqueue(bytes);
    },
  });

  try {
    await writer.addFile({
      name: fileName,
      modifiedAt,
      compression,
      stream,
    });
    await writer.finalize();
    await output.close();
    return new Blob(await archiveChunksPromise, { type: 'application/zip' });
  } catch (error: unknown) {
    await output.abort({ reason: error }).catch(() => undefined);
    await archiveChunksPromise.catch(() => undefined);
    throw error;
  } finally {
    await centralDirectoryStore.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
