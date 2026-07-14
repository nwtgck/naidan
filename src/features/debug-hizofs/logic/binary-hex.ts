export type BinaryHexRow = {
  readonly offset: number;
  readonly offsetLabel: string;
  readonly hexGroups: readonly string[];
  readonly ascii: string;
};

export function createBinaryHexRows({
  bytes,
  baseOffset,
  bytesPerRow,
}: {
  bytes: Uint8Array;
  baseOffset: number;
  bytesPerRow: number;
}): readonly BinaryHexRow[] {
  if (!Number.isSafeInteger(baseOffset) || baseOffset < 0) {
    throw new Error('Binary hex base offset must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < 1 || bytesPerRow > 64) {
    throw new Error('Binary hex row width must be between 1 and 64 bytes');
  }
  const rows: BinaryHexRow[] = [];
  for (let rowStart = 0; rowStart < bytes.byteLength; rowStart += bytesPerRow) {
    const rowBytes = bytes.subarray(rowStart, Math.min(bytes.byteLength, rowStart + bytesPerRow));
    const offset = baseOffset + rowStart;
    rows.push({
      offset,
      offsetLabel: formatBinaryOffset({ offset }),
      hexGroups: Array.from(rowBytes, byte => byte.toString(16).padStart(2, '0')),
      ascii: Array.from(rowBytes, byte => byte >= 0x20 && byte <= 0x7e
        ? String.fromCharCode(byte)
        : '.',
      ).join(''),
    });
  }
  return rows;
}

export function formatBinaryOffset({ offset }: { offset: number }): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Binary offset must be a non-negative safe integer');
  }
  return `0x${offset.toString(16).padStart(8, '0')}`;
}

export function formatBinaryRange({ offset, byteLength }: {
  offset: number;
  byteLength: number;
}): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Binary range length must be a non-negative safe integer');
  }
  if (byteLength === 0) {
    return `${formatBinaryOffset({ offset })} (empty)`;
  }
  return `${formatBinaryOffset({ offset })}..${formatBinaryOffset({ offset: offset + byteLength - 1 })}`;
}

export function formatBytesAsHex({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
