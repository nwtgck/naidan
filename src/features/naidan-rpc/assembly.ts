import type { RpcByteOwner } from './byte-budget';
import { check } from '@/features/naidan-rpc/primitives';

/** Allocate in proportion to received bytes, never an untrusted declaration.
 * Geometric growth also bounds allocation/object overhead for tiny chunks. */
export class ByteAssembly {
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array();
  private used = 0;
  private readonly limit: number;
  private readonly memory: RpcByteOwner | undefined;
  constructor({ limit, memory }: { limit: number; memory?: RpcByteOwner }) {
    this.limit = limit; this.memory = memory?.fork();
  }
  get byteLength(): number {
    return this.used;
  }
  append({ bytes }: { bytes: Uint8Array }): void {
    const required = this.used + bytes.length;
    check({ condition: required <= this.limit, code: 'RESOURCE_EXHAUSTED' });
    if (required > this.bytes.length) {
      const size = Math.min(this.limit, Math.max(required, this.bytes.length * 2, 1024));
      const grown = this.memory?.allocate({ bytes: size }) ?? new Uint8Array(size);
      grown.set(this.bytes.subarray(0, this.used));
      this.memory?.release({ bytes: this.bytes }); this.bytes = grown;
    }
    this.bytes.set(bytes, this.used); this.used = required;
  }
  dispose(): void {
    this.memory?.clear(); this.bytes = new Uint8Array(); this.used = 0;
  }
  finish(): Uint8Array<ArrayBuffer> {
    return this.bytes.subarray(0, this.used);
  }
}

export const TEST_ONLY = {
};
