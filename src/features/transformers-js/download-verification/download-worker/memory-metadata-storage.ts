import type { RuntimeMetadataStorage } from './metadata-storage';
import { expectedDecodedResponseByteLength, fullResourceResponseError } from '@/features/transformers-js/utils';

/** An operation-local alternative to OPFS, never a persisted model cache. */
export function createMemoryMetadataStorage({ maximumByteLength }: { maximumByteLength: number }) {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength <= 0) throw new Error('Invalid metadata memory budget');
  const files = new Map<string, Blob>();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let retainedByteLength = 0;
  let reservedByteLength = 0;
  let state: 'active' | 'disposed' = 'active';
  function check() {
    switch (state) {
    case 'active': return;
    case 'disposed': throw new Error('Metadata memory storage is disposed');
    default: {
      const _ex: never = state;
      throw new Error(`Unknown metadata storage state: ${_ex}`);
    }
    }
  }
  const storage: RuntimeMetadataStorage = {
    async stat({ url }) {
      check();
      return files.get(url)?.size;
    },
    async read({ url }) {
      check();
      const file = files.get(url);
      if (file === undefined) return undefined;
      return { byteLength: file.size, response: new Response(file.stream(), { headers: {
        'Content-Length': String(file.size),
        'Content-Type': url.endsWith('.json') ? 'application/json' : 'text/plain',
      } }) };
    },
    async write({ url, response }) {
      let reserved = 0;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        check();
        const error = fullResourceResponseError({ response });
        if (error !== undefined) throw error;
        const expected = expectedDecodedResponseByteLength({ response });
        if (expected !== undefined && retainedByteLength + reservedByteLength + expected > maximumByteLength) {
          throw new Error('Metadata memory budget exceeded');
        }
        if (response.body === null) throw new Error('Metadata response has no body');
        reader = response.body.getReader();
        readers.add(reader);
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        while (true) {
          const item = await reader.read();
          check();
          if (item.done) break;
          // Count all in-flight writes as well as committed Blobs. A concurrent
          // writer or replacement cannot borrow memory already held elsewhere.
          if (retainedByteLength + reservedByteLength + item.value.byteLength > maximumByteLength) {
            throw new Error('Metadata memory budget exceeded');
          }
          reserved += item.value.byteLength;
          reservedByteLength += item.value.byteLength;
          chunks.push(Uint8Array.from(item.value));
        }
        if (reserved === 0) throw new Error('Empty metadata is not a complete resource');
        if (expected !== undefined && reserved !== expected) throw new Error('Metadata response byte length mismatch');
        const file = new Blob(chunks);
        check();
        retainedByteLength += file.size - (files.get(url)?.size ?? 0);
        files.set(url, file);
      } finally {
        reservedByteLength -= reserved;
        if (reader !== undefined) {
          readers.delete(reader);
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
        } else {
          await response.body?.cancel();
        }
      }
    },
  };
  return {
    storage,
    snapshot(): ReadonlyMap<string, Blob> {
      check();
      // Blobs are immutable; callers cannot mutate the saved data or the map.
      return new Map(files);
    },
    async dispose() {
      state = 'disposed';
      files.clear();
      retainedByteLength = 0;
      // The owning operation/Worker bounds cleanup if a native stream stalls.
      await Promise.all([...readers].map(reader => reader.cancel()));
    },
  };
}

export const TEST_ONLY = {
};
