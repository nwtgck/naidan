import { compareBytes } from './bytes';

const textEncoder = new TextEncoder();

export function compareGitUtf8Strings({ left, right }: { left: string, right: string }): number {
  return compareBytes({ left: textEncoder.encode(left), right: textEncoder.encode(right) });
}

export function sortGitUtf8Strings({ values }: { values: Iterable<string> }): string[] {
  return sortByGitUtf8StringKey({ values, key: ({ value }) => value });
}

export function sortByGitUtf8StringKey<T>({ values, key, compareEqualKeys }: {
  values: Iterable<T>,
  key: ({ value }: { value: T }) => string,
  compareEqualKeys?: ({ left, right }: { left: T, right: T }) => number,
}): T[] {
  const keyed = [...values].map(value => ({
    value,
    bytes: textEncoder.encode(key({ value })),
  }));
  keyed.sort((left, right) => compareBytes({ left: left.bytes, right: right.bytes })
    || compareEqualKeys?.({ left: left.value, right: right.value })
    || 0);
  return keyed.map(entry => entry.value);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
