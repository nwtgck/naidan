import { createReadHandleFromStream, createWriteHandleFromStream } from './stream';
import type { WeshFileHandle } from '@/services/wesh/types';

/**
 * Creates a Wesh file handle that provides the given text as input.
 */
export function createTestReadHandleFromText({
  text,
}: {
  text: string;
}): WeshFileHandle {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
  return createReadHandleFromStream({ source });
}

/**
 * Creates a Wesh file handle that provides the given binary data as input.
 */
export function createTestReadHandleFromBytes({
  bytes,
}: {
  bytes: Uint8Array;
}): WeshFileHandle {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) {
        controller.enqueue(new Uint8Array(bytes));
      }
      controller.close();
    },
  });
  return createReadHandleFromStream({ source });
}

/**
 * Creates a capture object that stores all data written to its handle.
 */
export function createTestWriteCaptureHandle() {
  const chunks: Uint8Array[] = [];

  const handle = createWriteHandleFromStream({
    target: new WritableStream({
      write(chunk) {
        // Store a copy to avoid issues with buffer reuse in Wesh
        chunks.push(new Uint8Array(chunk));
      },
    }),
  });

  return {
    handle,
    get chunkCount() {
      return chunks.length;
    },
    get text() {
      const decoder = new TextDecoder();
      return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
    },
    get buffer() {
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    },
  };
}
