import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';

export type FileDataPayload = Readonly<{
  bytes: Uint8Array;
}>;

function validateBytes({ bytes }: { bytes: Uint8Array }): void {
  if (bytes.byteLength < 1 || bytes.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes) {
    throw new RangeError('File Data payload must contain 1..1,048,576 bytes');
  }
}

export function encodeFileDataPayload({ payload }: { payload: FileDataPayload }): Uint8Array {
  validateBytes({ bytes: payload.bytes });
  return Uint8Array.from(payload.bytes);
}

export function decodeFileDataPayload({ bytes }: { bytes: Uint8Array }): FileDataPayload {
  validateBytes({ bytes });
  return { bytes: Uint8Array.from(bytes) };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
