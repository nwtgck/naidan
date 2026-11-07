import { expect } from 'vitest';
import { Secret } from './secret';

/** Opt in per test file: ordinary deep equality cannot see a Secret's payload. */
export function installSecretEqualityTester(): void {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Vitest equality tester callback contract.
  expect.addEqualityTesters([(left: unknown, right: unknown): boolean | undefined => {
    if (!(left instanceof Secret) && !(right instanceof Secret)) {
      return undefined;
    }
    return left instanceof Secret && right instanceof Secret && Secret.equals(left, right);
  }]);
}

export const TEST_ONLY = {
};
