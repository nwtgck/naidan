import { compareBytes } from './bytes';

const textEncoder = new TextEncoder();

export function compareGitUtf8Strings({ left, right }: { left: string, right: string }): number {
  return compareBytes({ left: textEncoder.encode(left), right: textEncoder.encode(right) });
}

export function sortGitUtf8Strings({ values }: { values: Iterable<string> }): string[] {
  const keyed = [...values].map(value => ({ value, bytes: textEncoder.encode(value) }));
  keyed.sort((left, right) => compareBytes({ left: left.bytes, right: right.bytes }));
  return keyed.map(entry => entry.value);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
