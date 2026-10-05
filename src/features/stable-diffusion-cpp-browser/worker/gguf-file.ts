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

export const MODEL_FILE_PAGE_BYTES = 8 * 1024 * 1024;
export const MODEL_FILE_CACHE_BYTES = 64 * 1024 * 1024;

/** Share one cache across every mounted component. File identity, rather than
 * names or paths, keeps identically named weights from sharing bytes. */
export function createModelFileReadCache({ pageBytes, capacityBytes }: { pageBytes: number, capacityBytes: number }) {
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0 || !Number.isSafeInteger(capacityBytes) || capacityBytes < pageBytes) throw new Error('Invalid model read cache limits');
  type Page = { file: File, offset: number, bytes: Uint8Array<ArrayBuffer> };
  const files = new Map<File, Map<number, Page>>();
  const recent = new Map<Page, undefined>();
  let retainedBytes = 0;
  return {
    readPage({ file, reader, offset }: { file: File, reader: SyncBlobReader, offset: number }) {
      const start = Math.floor(offset / pageBytes) * pageBytes;
      const existing = files.get(file)?.get(start);
      if (existing) {
        recent.delete(existing); recent.set(existing, undefined);
        return { bytes: existing.bytes, start, cache: 'hit' as const, blobReadMs: 0 };
      }
      const length = Math.min(pageBytes, file.size - start);
      // Evict before allocating the next page. The bound covers cached bytes;
      // caller destinations, browser internals and garbage collection are separate.
      while (retainedBytes + length > capacityBytes) {
        const oldest = recent.keys().next().value;
        if (!oldest) throw new Error('Invalid model read cache state');
        recent.delete(oldest); retainedBytes -= oldest.bytes.byteLength;
        const entries = files.get(oldest.file)!;
        entries.delete(oldest.offset);
        if (entries.size === 0) files.delete(oldest.file);
      }
      const began = performance.now();
      const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(start, start + length)));
      const blobReadMs = performance.now() - began;
      if (bytes.byteLength !== length) throw new Error('Model file changed or could not be read completely');
      const page = { file, offset: start, bytes };
      let entries = files.get(file);
      if (!entries) {
        entries = new Map(); files.set(file, entries);
      }
      entries.set(start, page); recent.set(page, undefined); retainedBytes += bytes.byteLength;
      return { bytes, start, cache: 'miss' as const, blobReadMs };
    },
    retainedBytes(): number {
      return retainedBytes;
    },
    clear(): void {
      files.clear(); recent.clear(); retainedBytes = 0;
    },
  };
}

/** Used only after descriptor validation. Read-ahead coalesces native tiny reads
 * without materializing or transforming the complete GGUF/safetensors file. */
export function createModelFileSource({ file, reader, cache }: {
  file: File, reader: SyncBlobReader, cache: ReturnType<typeof createModelFileReadCache>,
}) {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid model file size');
  const metrics = { reads: 0, bytes: 0, maxOffset: 0, readMs: 0, blobReads: 0, blobBytes: 0, blobReadMs: 0, cacheHits: 0, cacheHitBytes: 0 };
  return {
    size: file.size,
    metrics() {
      return { ...metrics };
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External core range-reader callback signature.
    read(destination: Uint8Array, offset: number): number {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error('Invalid model file offset');
      const began = performance.now();
      const length = Math.min(destination.byteLength, file.size - offset, MODEL_FILE_PAGE_BYTES);
      let copied = 0, hitBytes = 0;
      while (copied < length) {
        const page = cache.readPage({ file, reader, offset: offset + copied });
        const from = offset + copied - page.start;
        const count = Math.min(page.bytes.byteLength - from, length - copied);
        destination.set(page.bytes.subarray(from, from + count), copied);
        switch (page.cache) {
        case 'hit': hitBytes += count; break;
        case 'miss':
          metrics.blobReads++; metrics.blobBytes += page.bytes.byteLength; metrics.blobReadMs += page.blobReadMs;
          break;
        default: { const exhaustive: never = page; throw new Error(String(exhaustive)); }
        }
        copied += count;
      }
      metrics.reads++; metrics.bytes += copied; metrics.maxOffset = Math.max(metrics.maxOffset, offset); metrics.readMs += performance.now() - began;
      // Hits count complete nonempty logical reads; hit bytes also include the
      // cached portion of a read that crosses into an uncached page.
      if (copied > 0 && hitBytes === copied) metrics.cacheHits++;
      metrics.cacheHitBytes += hitBytes;
      return copied;
    },
  };
}

export const TEST_ONLY = {
};
