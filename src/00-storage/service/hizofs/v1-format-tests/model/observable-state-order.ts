const textEncoder = new TextEncoder();

export function compareObservableNamesByUtf8({ left, right }: { left: string; right: string }): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const sharedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) throw new TypeError("UTF-8 comparison index escaped encoded bytes");
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
