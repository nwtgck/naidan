const UTF8 = new TextEncoder();

export function compareHizoFSStrings({ left, right }: {
  left: string;
  right: string;
}): number {
  if (left === right) {
    return 0;
  }
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const sharedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

export function compareHizoFSNumbers({ left, right }: {
  left: number;
  right: number;
}): number {
  return left - right;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
