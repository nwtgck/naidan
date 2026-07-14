import { decodeBase64Url, encodeBase64Url } from './base64-url';

const STABLE_ID_BYTE_LENGTH = 16;

export function createHizoFSStableId(): string {
  return encodeBase64Url({
    bytes: crypto.getRandomValues(new Uint8Array(STABLE_ID_BYTE_LENGTH)),
  });
}

export function validateHizoFSStableId({ value, fieldName }: {
  value: string;
  fieldName: string;
}): void {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url({ value });
  } catch (error) {
    throw new Error(
      `${fieldName} must be canonical Base64URL containing exactly 16 bytes`,
      { cause: error },
    );
  }
  if (bytes.byteLength !== STABLE_ID_BYTE_LENGTH || encodeBase64Url({ bytes }) !== value) {
    throw new Error(`${fieldName} must be canonical Base64URL containing exactly 16 bytes`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
