import { decodeBase64Url, encodeBase64Url } from '@/00-storage/service/encrypted-opfs/base64-url';

const OBJECT_ID_BYTE_LENGTH = 32;

export function createEncryptedOpfsObjectId(): string {
  return encodeBase64Url({
    bytes: crypto.getRandomValues(new Uint8Array(OBJECT_ID_BYTE_LENGTH)),
  });
}

export function decodeEncryptedOpfsObjectId({ objectId }: {
  objectId: string;
}): Uint8Array {
  const bytes = decodeBase64Url({ value: objectId });
  if (bytes.byteLength !== OBJECT_ID_BYTE_LENGTH) {
    throw new Error('EncryptedOpfs object ID must contain exactly 32 bytes');
  }
  if (encodeBase64Url({ bytes }) !== objectId) {
    throw new Error('EncryptedOpfs object ID is not canonical Base64URL');
  }
  return bytes;
}

export function getEncryptedOpfsObjectShard({ objectId }: {
  objectId: string;
}): string {
  const firstByte = decodeEncryptedOpfsObjectId({ objectId })[0];
  if (firstByte === undefined) {
    throw new Error('EncryptedOpfs object ID was empty');
  }
  return firstByte.toString(16).padStart(2, '0');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
