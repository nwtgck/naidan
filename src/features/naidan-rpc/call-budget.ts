import { check } from '@/features/naidan-rpc/primitives';

/** Local ownership shared across present and retiring peers. A failed cleanup
 * must retain its reservation; logical cancellation does not free native work. */
export class NaidanRpcCallBudget {
  private retained = 0;
  private readonly capacity: number;
  constructor({ capacity }: { capacity: number }) {
    this.capacity = capacity;
    check({ condition: Number.isInteger(capacity) && capacity > 0 && capacity <= 32, code: 'INVALID_ARGUMENT' });
  }
  reserve(): (() => void) | undefined {
    if (this.retained >= this.capacity) return undefined;
    this.retained++; let owned = true;
    return () => {
      if (owned) {
        owned = false; this.retained--;
      }
    };
  }
}

export const TEST_ONLY = {
};
