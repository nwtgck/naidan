/** Convert the public bigint pointer convention to a direct C export's width. */
export function nativePointer({ pointer, pointerBytes }: { pointer: number | bigint, pointerBytes: number }): number | bigint {
  if (pointerBytes !== 4 && pointerBytes !== 8) {
    throw new RangeError('Unsupported native pointer width');
  }
  if (typeof pointer === 'number' && !Number.isSafeInteger(pointer)) {
    throw new RangeError('Native pointer must be an exact integer');
  }
  const value = BigInt(pointer);
  if (value < 0n || value >= 1n << BigInt(pointerBytes * 8)) {
    throw new RangeError('Native pointer overflow');
  }
  return pointerBytes === 4 ? Number(value) : value;
}

export const TEST_ONLY = {
};
