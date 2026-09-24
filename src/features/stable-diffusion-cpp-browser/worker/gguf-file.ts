/** Storage policy belongs to Naidan, not to the native runtime. */
export interface SyncBlobReader {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard browser FileReaderSync method signature, scoped here to avoid global DOM/Worker lib conflicts.
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}
export interface RandomAccessSource {
  size: number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- External core range-reader callback signature.
  read(destination: Uint8Array, offset: number): number;
}
export function createGgufFileSource({ file, reader }: {
  file: File, reader: SyncBlobReader,
}): RandomAccessSource {
  if (!Number.isSafeInteger(file.size) || file.size < 24 || !/\.gguf$/i.test(file.name) || /-[0-9]{5}-of-[0-9]{5}\.gguf$/i.test(file.name)) throw new Error('Choose one complete GGUF file per model component');
  const source: RandomAccessSource = {
    size: file.size,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External core range-reader callback signature.
    read(destination, offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('Invalid GGUF file offset');
      const length = Math.min(destination.byteLength, file.size - offset);
      if (length === 0) return 0;
      const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + length)));
      if (bytes.byteLength !== length) throw new Error('GGUF file changed or could not be read completely');
      destination.set(bytes);
      return bytes.byteLength;
    },
  };
  const header = new Uint8Array(24);
  source.read(header, 0);
  const view = new DataView(header.buffer);
  if (view.getUint32(0, true) !== 0x46554747 || ![2, 3].includes(view.getUint32(4, true))) throw new Error('Expected a little-endian GGUF version 2 or 3 file');
  return source;
}
export const TEST_ONLY = {
};
