import { decodeCommandDataBytes, encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';

const SURROGATE_ESCAPE_BASE = 0xdc00;

export function createAwkByteCharacter({ byte }: { byte: number }): string {
  const normalizedByte = byte & 0xff;
  return String.fromCharCode(
    normalizedByte <= 0x7f
      ? normalizedByte
      : SURROGATE_ESCAPE_BASE + normalizedByte,
  );
}

export function decodeAwkDataBytes({ bytes }: { bytes: Uint8Array }): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    const slice = bytes.subarray(offset, offset + 4096);
    const codeUnits = new Array<number>(slice.byteLength);
    for (let index = 0; index < slice.byteLength; index += 1) {
      const byte = slice[index]!;
      codeUnits[index] = byte <= 0x7f ? byte : SURROGATE_ESCAPE_BASE + byte;
    }
    chunks.push(String.fromCharCode(...codeUnits));
  }
  return chunks.join('');
}

export function encodeAwkTextToByteString({ text }: { text: string }): string {
  return decodeAwkDataBytes({ bytes: encodeCommandDataText({ text }) });
}

export function decodeAwkByteStringToText({ text }: { text: string }): string {
  return decodeCommandDataBytes({ bytes: encodeCommandDataText({ text }) });
}

export const TEST_ONLY = {
  decodeAwkDataBytes,
  encodeAwkTextToByteString,
  decodeAwkByteStringToText,
};
