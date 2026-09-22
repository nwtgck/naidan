/**
 * Decode in the consuming Worker; bound intermediate data and final output.
 * Browser-side DecompressionStream('brotli') is allowed only on standalone paths.
 * Hosted browser paths must not call this decoder or use native Brotli decoding.
 */
export async function decodeEmbeddedBrotli({ base64, byteLength, sha256 }: { base64: string, byteLength: number, sha256: string }): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('Invalid embedded binary size');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid embedded binary hash');
  if (base64.length % 4 !== 0) throw new Error('Invalid embedded base64');
  // Allocate before opening streams so allocation failure cannot leave a reader behind.
  const result = new Uint8Array(byteLength);
  let offset = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset === base64.length) {
        controller.close(); return;
      }
      // A multiple of four keeps Base64 groups intact. No full-sized atob string,
      // compressed byte array or Blob copy is needed, even on older browsers.
      const end = Math.min(offset + 64 * 1024, base64.length);
      const text = base64.slice(offset, end);
      if (!(end === base64.length ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]*$/).test(text)) throw new Error('Invalid embedded base64');
      offset = end;
      if (typeof Uint8Array.fromBase64 === 'function') {
        controller.enqueue(Uint8Array.fromBase64(text));
      } else {
        const encoded = atob(text);
        const bytes = new Uint8Array(encoded.length);
        for (let index = 0; index < encoded.length; index++) bytes[index] = encoded.charCodeAt(index);
        controller.enqueue(bytes);
      }
    },
  }, { highWaterMark: 0 });
  // Intentionally require native Brotli for the smaller standalone payload. This
  // local type view bridges older TypeScript DOM declarations, not browser support:
  // the real constructor still rejects unsupported formats. Never patch globals.
  const NativeDecompressionStream = DecompressionStream as typeof DecompressionStream & {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Compression Streams constructor contract.
    new (format: 'brotli'): DecompressionStream,
  };
  const reader = compressed.pipeThrough(new NativeDecompressionStream('brotli')).getReader();
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - position) throw new Error('Embedded binary exceeds expected size');
      result.set(value, position); position += value.byteLength;
    }
    if (position !== byteLength) throw new Error('Embedded binary size mismatch');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  // Unlike gzip, Brotli has no content checksum. Verify the decoded bytes against
  // the build-verified manifest, including same-length corruption. Web Crypto
  // avoids shipping a hashing library; its internal input snapshot may copy bytes.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', result));
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== sha256) throw new Error('Embedded binary integrity mismatch');
  return result;
}
export const TEST_ONLY = {
};
