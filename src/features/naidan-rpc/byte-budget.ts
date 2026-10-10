import { check, NaidanRpcPublicError } from '@/features/naidan-rpc/primitives';

/** One host budget survives replacement of the peers that borrow it. */
export class NaidanRpcByteBudget {
  private retained = 0;
  private readonly capacity: number;

  constructor({ capacity = 256 * 1024 * 1024 }: { capacity?: number } = {}) {
    check({ condition: Number.isSafeInteger(capacity) && capacity > 0, code: 'INVALID_ARGUMENT' });
    this.capacity = capacity;
  }

  reserve({ bytes }: { bytes: number }): () => void {
    check({ condition: Number.isSafeInteger(bytes) && bytes >= 0, code: 'INVALID_ARGUMENT' });
    if (bytes > this.capacity - this.retained) throw new NaidanRpcPublicError({
      code: 'RESOURCE_EXHAUSTED',
      details: { scope: 'rpc-memory', constraint: 'retained-bytes', limit: this.capacity, observed: this.retained + bytes },
    });
    this.retained += bytes; let owned = true;
    return () => {
      if (owned) {
        owned = false; this.retained -= bytes;
      }
    };
  }

  owner(): RpcByteOwner {
    return new RpcByteOwner({ budget: this });
  }
}

/** Explicit ownership, not GC observation. Grow/copy holds old and new buffers
 * simultaneously. Failure never waits while retaining a partial message. */
export class RpcByteOwner {
  private readonly budget: NaidanRpcByteBudget;
  private readonly buffers = new Map<ArrayBuffer, () => void>();
  private readonly charges = new Set<() => void>();
  private readonly children = new Set<RpcByteOwner>();
  private parent: RpcByteOwner | undefined;
  private closed = false;

  constructor({ budget }: { budget: NaidanRpcByteBudget }) {
    this.budget = budget;
  }

  fork(): RpcByteOwner {
    check({ condition: !this.closed, code: 'CANCELLED' });
    const child = new RpcByteOwner({ budget: this.budget }); child.parent = this;
    this.children.add(child); return child;
  }

  charge({ bytes }: { bytes: number }): void {
    check({ condition: !this.closed, code: 'CANCELLED' });
    if (bytes !== 0) this.charges.add(this.budget.reserve({ bytes }));
  }

  allocate({ bytes }: { bytes: number }): Uint8Array<ArrayBuffer> {
    check({ condition: !this.closed, code: 'CANCELLED' });
    const release = this.budget.reserve({ bytes });
    try {
      const value = new Uint8Array(bytes); this.buffers.set(value.buffer, release); return value;
    } catch (error) {
      release(); throw error;
    }
  }

  retain({ bytes }: { bytes: Uint8Array }): void {
    check({ condition: !this.closed && bytes.buffer instanceof ArrayBuffer, code: 'INVALID_ARGUMENT' });
    if (bytes.buffer instanceof ArrayBuffer && !this.buffers.has(bytes.buffer)) this.buffers.set(bytes.buffer, this.budget.reserve({ bytes: bytes.buffer.byteLength }));
  }

  release({ bytes }: { bytes: Uint8Array }): void {
    if (bytes.buffer instanceof ArrayBuffer) {
      this.buffers.get(bytes.buffer)?.(); this.buffers.delete(bytes.buffer);
    }
  }

  clear(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children) child.clear();
    for (const release of this.buffers.values()) release();
    for (const release of this.charges) release();
    this.buffers.clear(); this.charges.clear(); this.children.clear();
    this.parent?.children.delete(this); this.parent = undefined;
  }
}

export const TEST_ONLY = {
  retained: ({ budget }: { budget: NaidanRpcByteBudget }) => budget['retained'],
};
