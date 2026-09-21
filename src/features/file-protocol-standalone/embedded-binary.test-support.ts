import { Duplex } from 'node:stream';
import { createBrotliDecompress } from 'node:zlib';
import { vi } from 'vitest';

/** Test-only bridge for Node releases with zlib Brotli but no Web Streams format.
 * Prefer the native API when present. This helper must never enter application
 * code: production deliberately rejects browsers without native Brotli. */
export function installBrotliDecoderForTest(): 'native' | 'node-zlib-bridge' {
  try {
    Reflect.construct(DecompressionStream, ['brotli']);
    return 'native';
  } catch {
    vi.stubGlobal('DecompressionStream', class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Compression Streams constructor contract.
      constructor(format: string) {
        if (format !== 'brotli') throw new TypeError('Test bridge only accepts Brotli');
        const stream = Duplex.toWeb(createBrotliDecompress());
        this.readable = stream.readable as ReadableStream<Uint8Array>;
        this.writable = stream.writable as WritableStream<BufferSource>;
      }
    });
    return 'node-zlib-bridge';
  }
}
export const TEST_ONLY = {
};
