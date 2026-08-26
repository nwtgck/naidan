const nonAsciiDateWhitespacePattern = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;

export function containsNonAsciiDateWhitespace({
  value,
}: {
  value: string;
}): boolean {
  return nonAsciiDateWhitespacePattern.test(value);
}

export function trimAsciiDateWhitespace({
  value,
}: {
  value: string;
}): string {
  return value.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/gu, '');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
