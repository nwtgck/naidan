import { describe, expect, it } from 'vitest';
import { createInvestigationProviderRetentionBudget } from './investigation-provider-retention';

const capacity = { nativeBinaryBytes: 8, nativeJsonCharacters: 8, providerJsonCharacters: 8 };
const empty = { nativeBinaryBytes: 0, nativeJsonCharacters: 0, providerJsonCharacters: 0 };

describe('investigation Provider retention ownership budget', () => {
  it('reserves before work and does not refund a pending owner on a deadline', () => {
    const budget = createInvestigationProviderRetentionBudget({ limits: capacity, retained: empty });
    budget.reserve({ maximum: { nativeBinaryBytes: 8, nativeJsonCharacters: 8, providerJsonCharacters: 8 } });
    expect(() => budget.reserve({ maximum: { ...empty, nativeBinaryBytes: 1 } })).toThrow('Investigation recording capacity is exhausted');
    expect(budget.snapshot()).toEqual({ retained: empty, reserved: capacity });
  });

  it('replaces a released reservation with actual retained data rather than charging both', () => {
    const budget = createInvestigationProviderRetentionBudget({ limits: capacity, retained: empty });
    const reservation = budget.reserve({ maximum: capacity });
    reservation.release({ retained: { nativeBinaryBytes: 2, nativeJsonCharacters: 3, providerJsonCharacters: 4 } });
    expect(budget.snapshot()).toEqual({ retained: { nativeBinaryBytes: 2, nativeJsonCharacters: 3, providerJsonCharacters: 4 }, reserved: empty });
    budget.reserve({ maximum: { nativeBinaryBytes: 6, nativeJsonCharacters: 5, providerJsonCharacters: 4 } });
    expect(() => reservation.release({ retained: empty })).toThrow('Investigation reservation was already released');
  });

  it('rejects an oversized retained result without refunding any reservation', () => {
    const budget = createInvestigationProviderRetentionBudget({ limits: capacity, retained: empty });
    const reservation = budget.reserve({ maximum: { ...empty, nativeBinaryBytes: 1 } });
    expect(() => reservation.release({ retained: { ...empty, nativeBinaryBytes: 2 } })).toThrow('Investigation recording exceeded its reservation');
    expect(budget.snapshot().reserved.nativeBinaryBytes).toBe(1);
  });

  it('accounts for restored retained data before new work and keeps ledgers independent', () => {
    const first = createInvestigationProviderRetentionBudget({ limits: capacity, retained: { ...empty, providerJsonCharacters: 8 } });
    const second = createInvestigationProviderRetentionBudget({ limits: capacity, retained: empty });
    expect(() => first.reserve({ maximum: { ...empty, providerJsonCharacters: 1 } })).toThrow('Investigation recording capacity is exhausted');
    expect(() => second.reserve({ maximum: capacity })).not.toThrow();
    expect(first.snapshot().reserved).toEqual(empty);
  });
});
