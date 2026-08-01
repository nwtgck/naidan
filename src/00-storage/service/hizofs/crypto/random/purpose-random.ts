import { customRandom, nanoid, urlAlphabet } from "nanoid";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseCredentialSlotId,
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type CredentialSlotId,
  type FileSystemId,
  type MutationId,
  type PublicationId,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/crypto/secret-types";
import {
  credentialWrapNonce,
  recordNonce,
  segmentFooterNonce,
  superblockNonce,
  unlockAuthenticatorNonce,
  type CredentialWrapNonce,
  type RecordNonce,
  type SegmentFooterNonce,
  type SuperblockNonce,
  type UnlockAuthenticatorNonce,
} from "@/00-storage/service/hizofs/crypto/types";
import {
  generateFileSystemRootKey as generateRootKey,
  generateNonce,
  generateUniqueRandomBytes,
  type RandomByteSource,
} from "./random-bytes";

export type { RandomByteSource } from "./random-bytes";

function generateNanoId21({ randomSource }: { randomSource?: RandomByteSource }): string {
  if (randomSource === undefined) return nanoid();
  const generate = customRandom(urlAlphabet, 21, (byteLength) => {
    const bytes = new Uint8Array(byteLength);
    randomSource({ bytes });
    return bytes;
  });
  return generate();
}

async function generateUniqueNanoId<T>({ isUsed, parse, randomSource }: {
  isUsed: ({ id }: { id: T }) => Promise<boolean>;
  parse: ({ value }: { value: string }) => T;
  randomSource?: RandomByteSource;
}): Promise<T> {
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const id = parse({ value: generateNanoId21({ randomSource }) });
    if (!await isUsed({ id })) return id;
  }
  throw new Error("purpose-specific Nano ID generation exhausted the collision retry bound");
}

export async function generateFileSystemId({ isUsed, randomSource }: {
  isUsed: ({ id }: { id: FileSystemId }) => Promise<boolean>;
  randomSource?: RandomByteSource;
}): Promise<FileSystemId> {
  return await generateUniqueNanoId({ isUsed, parse: parseFileSystemId, randomSource });
}

export async function generateCredentialSlotId({ isUsed, randomSource }: {
  isUsed: ({ id }: { id: CredentialSlotId }) => Promise<boolean>;
  randomSource?: RandomByteSource;
}): Promise<CredentialSlotId> {
  return await generateUniqueNanoId({ isUsed, parse: parseCredentialSlotId, randomSource });
}

export function generateCredentialSalt({ randomSource }: {
  randomSource?: RandomByteSource;
} = {}): Uint8Array {
  return generateUniqueRandomBytes({ byteLength: 16, isUsed: () => false, randomSource });
}

export function generateFileSystemRootKey({ randomSource }: {
  randomSource?: RandomByteSource;
} = {}): FileSystemRootKey {
  return generateRootKey({ randomSource });
}

export function generateRecordNonce({ randomSource }: { randomSource?: RandomByteSource }): RecordNonce {
  return recordNonce({ bytes: generateNonce({ randomSource }) });
}
export function generateSuperblockNonce({ randomSource }: { randomSource?: RandomByteSource }): SuperblockNonce {
  return superblockNonce({ bytes: generateNonce({ randomSource }) });
}
export function generateSegmentFooterNonce({ randomSource }: { randomSource?: RandomByteSource }): SegmentFooterNonce {
  return segmentFooterNonce({ bytes: generateNonce({ randomSource }) });
}
export function generateUnlockAuthenticatorNonce({ randomSource }: { randomSource?: RandomByteSource }): UnlockAuthenticatorNonce {
  return unlockAuthenticatorNonce({ bytes: generateNonce({ randomSource }) });
}
export function generateCredentialWrapNonce({ randomSource }: { randomSource?: RandomByteSource }): CredentialWrapNonce {
  return credentialWrapNonce({ bytes: generateNonce({ randomSource }) });
}

async function generateUniqueIdentity<T>({
  isUsed,
  parse,
  randomSource,
}: {
  isUsed: ({ id }: { id: T }) => Promise<boolean>;
  parse: ({ bytes }: { bytes: Uint8Array }) => T;
  randomSource?: RandomByteSource;
}): Promise<T> {
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const bytes = generateUniqueRandomBytes({ byteLength: 16, isUsed: () => false, randomSource });
    const id = parse({ bytes });
    if (!await isUsed({ id })) return id;
  }
  throw new Error("purpose-specific identity generation exhausted the collision retry bound");
}

export async function generateSegmentId({ isUsed, randomSource }: {
  isUsed: ({ id }: { id: SegmentId }) => Promise<boolean>;
  randomSource?: RandomByteSource;
}): Promise<SegmentId> {
  return await generateUniqueIdentity({ isUsed, parse: parseSegmentId, randomSource });
}
export async function generateMutationId({ isUsed, randomSource }: {
  isUsed: ({ id }: { id: MutationId }) => Promise<boolean>;
  randomSource?: RandomByteSource;
}): Promise<MutationId> {
  return await generateUniqueIdentity({ isUsed, parse: parseMutationId, randomSource });
}
export async function generatePublicationId({ isUsed, randomSource }: {
  isUsed: ({ id }: { id: PublicationId }) => Promise<boolean>;
  randomSource?: RandomByteSource;
}): Promise<PublicationId> {
  return await generateUniqueIdentity({ isUsed, parse: parsePublicationId, randomSource });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
