import { decodeBase64Url, encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';

const OBJECT_ID_BYTE_LENGTH = 32;

export function createHizoFSObjectId(): string {
  return encodeBase64Url({
    bytes: crypto.getRandomValues(new Uint8Array(OBJECT_ID_BYTE_LENGTH)),
  });
}

export function decodeHizoFSObjectId({ objectId }: {
  objectId: string;
}): Uint8Array {
  const bytes = decodeBase64Url({ value: objectId });
  if (bytes.byteLength !== OBJECT_ID_BYTE_LENGTH) {
    throw new Error('HizoFS object ID must contain exactly 32 bytes');
  }
  if (encodeBase64Url({ bytes }) !== objectId) {
    throw new Error('HizoFS object ID is not canonical Base64URL');
  }
  return bytes;
}

export function getHizoFSObjectShard({ objectId }: {
  objectId: string;
}): string {
  const firstByte = decodeHizoFSObjectId({ objectId })[0];
  if (firstByte === undefined) {
    throw new Error('HizoFS object ID was empty');
  }
  return firstByte.toString(16).padStart(2, '0');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
