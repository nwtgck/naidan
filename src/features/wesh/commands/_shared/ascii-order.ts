export function compareAsciiStrings({
  left,
  right,
}: {
  left: string;
  right: string;
}): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
