import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
} from '@/00-storage/service/hizofs/00-format';
import { FileSystemRootKey } from '@/00-storage/service/hizofs/crypto/secret-types';

export type RandomByteSource = ({ bytes }: { bytes: Uint8Array }) => void;

function defaultRandomSource({ bytes }: { bytes: Uint8Array }): void {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  globalThis.crypto.getRandomValues(ownedBytes);
  bytes.set(ownedBytes);
}

function isAllZero({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.every((value) => value === 0);
}

export function generateNonce({ randomSource = defaultRandomSource }: {
  randomSource?: RandomByteSource;
} = {}): Uint8Array {
  const nonce = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes);
  randomSource({ bytes: nonce });
  return nonce;
}

export function generateFileSystemRootKey({ randomSource = defaultRandomSource }: {
  randomSource?: RandomByteSource;
} = {}): FileSystemRootKey {
  return FileSystemRootKey.create({
    bytes: generateUniqueRandomBytes({
      byteLength: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.rootKeyBytes,
      isUsed: () => false,
      randomSource,
    }),
  });
}

export function generateUniqueRandomBytes({ byteLength, isUsed, randomSource = defaultRandomSource }: {
  byteLength: number;
  isUsed: ({ bytes }: { bytes: Uint8Array }) => boolean;
  randomSource?: RandomByteSource;
}): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 65_536) {
    throw new RangeError('random identity byte length is outside the supported bound');
  }
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const candidate = new Uint8Array(byteLength);
    randomSource({ bytes: candidate });
    if (!isAllZero({ bytes: candidate }) && !isUsed({ bytes: candidate })) return candidate;
  }
  throw new Error('random identity generation exhausted the collision retry bound');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  isAllZero,
};
