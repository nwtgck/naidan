import { requireValue } from '@/features/naidan-piping-duplex/bytes';
const PAGE_BYTES = 4096;
const CAPACITY_BYTES = 65536;
/** Immutable bounded pages make speculative state updates rollback-safe. */
export class ByteQueue {
  private internalPages: readonly Uint8Array[];
  private internalLength: number;
  private constructor({ pages, length }: {
        pages: readonly Uint8Array[];
        length: number;
    }) {
    this.internalPages = pages;
    this.internalLength = length;
  }
  static empty(): ByteQueue {
    return new ByteQueue({ pages: [], length: 0 });
  }
  get length(): number {
    return this.internalLength;
  }
  get pageCount(): number {
    return this.internalPages.length;
  }
  append({ bytes }: {
        bytes: Uint8Array;
    }): ByteQueue {
    requireValue({ condition: this.internalLength + bytes.length <= CAPACITY_BYTES, message: 'Read buffer capacity' });
    const pages = [...this.internalPages];
    let offset = 0;
    const tail = pages[pages.length - 1];
    if (tail && tail.length < PAGE_BYTES && bytes.length > 0) {
      const added = Math.min(PAGE_BYTES - tail.length, bytes.length), joined = new Uint8Array(tail.length + added);
      joined.set(tail);
      joined.set(bytes.subarray(0, added), tail.length);
      pages[pages.length - 1] = joined;
      offset = added;
    }
    while (offset < bytes.length) {
      const end = Math.min(offset + PAGE_BYTES, bytes.length);
      pages.push(bytes.slice(offset, end));
      offset = end;
    }
    return new ByteQueue({ pages, length: this.internalLength + bytes.length });
  }
  take(): {
        bytes: Uint8Array;
        remaining: ByteQueue;
    } | undefined {
    const first = this.internalPages[0];
    if (!first)
      return undefined;
    return { bytes: first.slice(), remaining: new ByteQueue({ pages: this.internalPages.slice(1), length: this.internalLength - first.length }) };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
