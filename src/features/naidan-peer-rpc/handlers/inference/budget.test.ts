import { expect, it } from 'vitest';
import { createInferenceBudget } from './budget';

it('joins every outstanding reservation without freeing capacity early', async () => {
  const budget = createInferenceBudget({ capacity: 8 });
  const first = budget.reserve({ bytes: 3 }), second = budget.reserve({ bytes: 5 });
  let idle = false; const pending = budget.whenIdle().then(() => {
    idle = true;
  });
  first.release(); first.release(); await Promise.resolve();
  expect(budget.reserved).toBe(5); expect(idle).toBe(false);
  expect(() => budget.reserve({ bytes: 4 })).toThrow();
  second.release(); await pending; expect(budget.reserved).toBe(0); expect(idle).toBe(true);
});

it('a later reservation cycle does not reuse an already resolved idle promise', async () => {
  const budget = createInferenceBudget({ capacity: 8 });
  await budget.whenIdle(); const first = budget.reserve({ bytes: 8 });
  const before = budget.whenIdle(); first.release(); await before;
  const second = budget.reserve({ bytes: 8 }); let ended = false;
  const after = budget.whenIdle().then(() => {
    ended = true;
  });
  await Promise.resolve(); expect(ended).toBe(false); second.release(); await after;
});

it('zero-byte and rejected reservations do not create pending idle owners', async () => {
  const budget = createInferenceBudget({ capacity: 8 });
  expect(() => budget.reserve({ bytes: -1 })).toThrow();
  expect(() => budget.reserve({ bytes: 9 })).toThrow();
  const empty = budget.reserve({ bytes: 0 }); await budget.whenIdle();
  empty.release(); await budget.whenIdle(); expect(budget.reserved).toBe(0);
});
