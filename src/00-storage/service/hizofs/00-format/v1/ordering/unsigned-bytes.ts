export function compareUnsignedBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new Error('unsigned byte comparison length invariant failed');
    }
    const difference = leftByte - rightByte;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (left.byteLength === right.byteLength) return 0;
  return left.byteLength < right.byteLength ? -1 : 1;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
