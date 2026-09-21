/** Decode in the consuming Worker; bound intermediate data and final output. */
export async function decodeEmbeddedGzip({ base64, byteLength }: { base64: string, byteLength: number }): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('Invalid embedded binary size');
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
  const reader = compressed.pipeThrough(new DecompressionStream('gzip')).getReader();
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > byteLength - position) throw new Error('Embedded binary exceeds expected size');
      result.set(value, position); position += value.byteLength;
    }
    if (position !== byteLength) throw new Error('Embedded binary size mismatch');
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export const TEST_ONLY = {
};
