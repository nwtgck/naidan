import { requireValue } from '@/features/naidan-piping-duplex/bytes';

const PAGE_BYTES = 4096;
/** Mutable pages have one owner. Reads copy before exposing bytes; no crypto backing escapes. */
export class OwnedByteQueue {
  private pages: Uint8Array[] = [];
  private head = 0;
  private start = 0;
  private tail = PAGE_BYTES;
  private length = 0;
  private readonly capacity: number;

  constructor({ capacity }: { capacity: number }) {
    this.capacity = capacity;
    requireValue({ condition: Number.isSafeInteger(capacity) && capacity > 0, message: 'Invalid byte queue capacity' });
  }

  get byteLength(): number {
    return this.length;
  }

  append({ bytes }: { bytes: Uint8Array }): void {
    requireValue({ condition: bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer && bytes.length <= this.capacity - this.length, message: 'Byte queue capacity exceeded' });
    let offset = 0;
    while (offset < bytes.length) {
      if (this.tail === PAGE_BYTES) {
        this.pages.push(new Uint8Array(PAGE_BYTES)); this.tail = 0;
      }
      const size = Math.min(PAGE_BYTES - this.tail, bytes.length - offset);
      this.pages[this.pages.length - 1]!.set(bytes.subarray(offset, offset + size), this.tail);
      this.tail += size; offset += size;
    }
    this.length += bytes.length;
  }

  take({ maximum }: { maximum: number }): Uint8Array<ArrayBuffer> {
    requireValue({ condition: Number.isSafeInteger(maximum) && maximum > 0, message: 'Invalid read size' });
    const bytes = new Uint8Array(Math.min(maximum, this.length)); let offset = 0;
    while (offset < bytes.length) {
      const size = Math.min(PAGE_BYTES - this.start, bytes.length - offset), page = this.pages[this.head]!;
      bytes.set(page.subarray(this.start, this.start + size), offset);
      this.start += size; offset += size;
      if (this.start === PAGE_BYTES) {
        this.pages[this.head] = new Uint8Array(); this.head++; this.start = 0;
      }
    }
    this.length -= bytes.length;
    if (this.length === 0) this.clear();
    else if (this.head > 32 && this.head * 2 >= this.pages.length) {
      this.pages = this.pages.slice(this.head); this.head = 0;
    }
    return bytes;
  }

  clear(): number {
    const released = this.length;
    this.pages = []; this.head = 0; this.start = 0; this.tail = PAGE_BYTES; this.length = 0;
    return released;
  }
}

export const TEST_ONLY = {
};
