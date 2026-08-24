import { decodeCommandDataBytes } from '@/features/wesh/commands/_shared/data-codec';

const utf8ZipEntryNameDecoder = new TextDecoder();

export function decodeWeshZipEntryName({
  bytes,
  isUtf8,
}: {
  bytes: Uint8Array,
  isUtf8: boolean,
}): string {
  return isUtf8
    ? utf8ZipEntryNameDecoder.decode(bytes)
    : decodeCommandDataBytes({ bytes });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
