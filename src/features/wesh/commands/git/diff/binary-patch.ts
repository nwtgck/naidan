import { deflateZlib } from '@/features/wesh/commands/git/zlib';

const GIT_BASE85_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const MAX_BINARY_PATCH_LINE_BYTES = 52;
const BASE85_POWERS = [85 ** 4, 85 ** 3, 85 ** 2, 85, 1] as const;

function binaryPatchLengthMarker({ length }: { length: number }): string {
  if (!Number.isInteger(length) || length < 1 || length > MAX_BINARY_PATCH_LINE_BYTES)
    throw new Error(`invalid git binary patch line length: ${length}`);
  if (length <= 26) return String.fromCharCode('A'.charCodeAt(0) + length - 1);
  return String.fromCharCode('a'.charCodeAt(0) + length - 27);
}

function encodeBase85Group({ bytes, offset }: { bytes: Uint8Array, offset: number }): string {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  let output = '';
  for (const power of BASE85_POWERS) {
    const digit = Math.floor(value / power) % 85;
    output += GIT_BASE85_ALPHABET[digit]!;
  }
  return output;
}

function encodeBase85Line({ bytes }: { bytes: Uint8Array }): string {
  let output = binaryPatchLengthMarker({ length: bytes.byteLength });
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    output += encodeBase85Group({ bytes, offset });
  }
  return output;
}

export async function encodeGitBinaryLiteral({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const compressed = await deflateZlib({ bytes });
  let encoded = `literal ${bytes.byteLength}\n`;
  for (let offset = 0; offset < compressed.byteLength; offset += MAX_BINARY_PATCH_LINE_BYTES) {
    encoded += `${encodeBase85Line({ bytes: compressed.subarray(offset, offset + MAX_BINARY_PATCH_LINE_BYTES) })}\n`;
  }
  return encoded;
}

export const TEST_ONLY = {
  encodeBase85Line,
};
