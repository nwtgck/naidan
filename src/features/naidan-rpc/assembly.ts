import { check } from '@/features/naidan-rpc/primitives';

/** Allocate in proportion to received bytes, never an untrusted declaration.
 * Geometric growth also bounds allocation/object overhead for tiny chunks. */
export class ByteAssembly {
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array();
  private used = 0;
  private readonly limit: number;
  constructor({ limit }: { limit: number }) {
    this.limit = limit;
  }
  get byteLength(): number {
    return this.used;
  }
  append({ bytes }: { bytes: Uint8Array }): void {
    const required = this.used + bytes.length;
    check({ condition: required <= this.limit, code: 'RESOURCE_EXHAUSTED' });
    if (required > this.bytes.length) {
      const grown = new Uint8Array(Math.min(this.limit, Math.max(required, this.bytes.length * 2, 1024)));
      grown.set(this.bytes.subarray(0, this.used));
      this.bytes = grown;
    }
    this.bytes.set(bytes, this.used); this.used = required;
  }
  finish(): Uint8Array<ArrayBuffer> {
    return this.bytes.subarray(0, this.used);
  }
}

export const TEST_ONLY = {
};
