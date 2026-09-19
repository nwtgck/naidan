export function concatBytes({ chunks }: { chunks: readonly Uint8Array[] }): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const HEX_DIGITS = '0123456789abcdef';

function hexNibble({ code }: { code: number }): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

export function bytesToHex({ bytes }: { bytes: Uint8Array }): string {
  let result = '';
  for (const byte of bytes) {
    result += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!;
  }
  return result;
}

export function writeHexBytes({ hex, bytes, offset, byteLength }: {
  hex: string,
  bytes: Uint8Array,
  offset: number,
  byteLength: number | undefined,
}): void {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error(`Invalid hexadecimal value: ${hex}`);
  }
  const decodedLength = hex.length / 2;
  if ((byteLength !== undefined && decodedLength !== byteLength)
    || offset < 0
    || offset + decodedLength > bytes.byteLength) {
    throw new Error(`Invalid hexadecimal value: ${hex}`);
  }
  for (let index = 0; index < decodedLength; index += 1) {
    const high = hexNibble({ code: hex.charCodeAt(index * 2) });
    const low = hexNibble({ code: hex.charCodeAt(index * 2 + 1) });
    if (high < 0 || low < 0) throw new Error(`Invalid hexadecimal value: ${hex}`);
    bytes[offset + index] = (high << 4) | low;
  }
}

export function hexToBytes({ hex }: { hex: string }): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error(`Invalid hexadecimal value: ${hex}`);
  }
  const result = new Uint8Array(hex.length / 2);
  writeHexBytes({ hex, bytes: result, offset: 0, byteLength: undefined });
  return result;
}

export function compareBytes({ left, right }: { left: Uint8Array, right: Uint8Array }): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export const TEST_ONLY = {
};
