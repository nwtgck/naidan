import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAppBlockingOperation,
  TEST_ONLY,
  useAppBlockingOperation,
} from './useAppBlockingOperation';

afterEach(() => {
  TEST_ONLY.activeOperations.clear();
});

describe('app blocking operations', () => {
  it('remains active until every operation finishes', () => {
    const { active } = useAppBlockingOperation();
    const finishFirst = beginAppBlockingOperation({
      operation: 'storage_transition',
    });
    const finishSecond = beginAppBlockingOperation({
      operation: 'storage_transition',
    });

    expect(active.value).toBe(true);

    finishFirst();
    expect(active.value).toBe(true);

    finishSecond();
    expect(active.value).toBe(false);
  });

  it('allows an operation finish callback to be called repeatedly', () => {
    const { active } = useAppBlockingOperation();
    const finish = beginAppBlockingOperation({
      operation: 'storage_transition',
    });

    finish();
    finish();

    expect(active.value).toBe(false);
  });
});
