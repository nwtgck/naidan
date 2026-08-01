export type BinaryOffset = number | bigint;

export type BinaryHexRow = {
  readonly offset: bigint;
  readonly offsetLabel: string;
  readonly hexGroups: readonly string[];
  readonly ascii: string;
};

function toBinaryOffsetBigInt({ offset }: { offset: BinaryOffset }): bigint {
  switch (typeof offset) {
  case "bigint":
    if (offset < 0n) throw new Error("Binary offset must be non-negative");
    return offset;
  case "number":
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Binary offset number must be a non-negative safe integer");
    }
    return BigInt(offset);
  default: return offset satisfies never;
  }
}

export function createBinaryHexRows({
  bytes,
  baseOffset,
  bytesPerRow,
}: {
  bytes: Uint8Array;
  baseOffset: BinaryOffset;
  bytesPerRow: number;
}): readonly BinaryHexRow[] {
  const normalizedBaseOffset = toBinaryOffsetBigInt({ offset: baseOffset });
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < 1 || bytesPerRow > 64) {
    throw new Error("Binary hex row width must be between 1 and 64 bytes");
  }
  const rows: BinaryHexRow[] = [];
  for (let rowStart = 0; rowStart < bytes.byteLength; rowStart += bytesPerRow) {
    const rowBytes = bytes.subarray(rowStart, Math.min(bytes.byteLength, rowStart + bytesPerRow));
    const offset = normalizedBaseOffset + BigInt(rowStart);
    rows.push({
      offset,
      offsetLabel: formatBinaryOffset({ offset }),
      hexGroups: Array.from(rowBytes, byte => byte.toString(16).padStart(2, "0")),
      ascii: Array.from(rowBytes, byte => byte >= 0x20 && byte <= 0x7e
        ? String.fromCharCode(byte)
        : ".",
      ).join(""),
    });
  }
  return rows;
}

export function formatBinaryOffset({ offset }: { offset: BinaryOffset }): string {
  const normalizedOffset = toBinaryOffsetBigInt({ offset });
  return `0x${normalizedOffset.toString(16).padStart(8, "0")}`;
}

export function formatBinaryRange({ offset, byteLength }: {
  offset: BinaryOffset;
  byteLength: number;
}): string {
  const normalizedOffset = toBinaryOffsetBigInt({ offset });
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Binary range length must be a non-negative safe integer");
  }
  if (byteLength === 0) {
    return `${formatBinaryOffset({ offset: normalizedOffset })} (empty)`;
  }
  return `${formatBinaryOffset({ offset: normalizedOffset })}..${formatBinaryOffset({
    offset: normalizedOffset + BigInt(byteLength - 1),
  })}`;
}

export function formatBytesAsHex({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
