import { customAlphabet } from 'nanoid';

const HIZOFS_OBJECT_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const HIZOFS_OBJECT_ID_LENGTH = 21;
const HIZOFS_OBJECT_SHARD_HEX_LENGTH = 2;
const HIZOFS_OBJECT_SHARD_BIT_LENGTH = 8;
const HIZOFS_OBJECT_ID_CHARACTER_BIT_LENGTH = 6;
const createNanoId = customAlphabet(
  HIZOFS_OBJECT_ID_ALPHABET,
  HIZOFS_OBJECT_ID_LENGTH,
);

export function createHizoFSObjectId(): string {
  return createNanoId();
}

export function validateHizoFSObjectId({ objectId }: {
  objectId: string;
}): void {
  if (objectId.length !== HIZOFS_OBJECT_ID_LENGTH) {
    throw new Error(
      `HizoFS object ID must contain exactly ${String(HIZOFS_OBJECT_ID_LENGTH)} characters`,
    );
  }
  for (const character of objectId) {
    if (!HIZOFS_OBJECT_ID_ALPHABET.includes(character)) {
      throw new Error('HizoFS object ID contains a character outside its canonical alphabet');
    }
  }
}

export function getHizoFSObjectShard({ objectId }: {
  objectId: string;
}): string {
  validateHizoFSObjectId({ objectId });
  const firstCharacter = objectId[0];
  const secondCharacter = objectId[1];
  if (firstCharacter === undefined || secondCharacter === undefined) {
    throw new Error('HizoFS object ID is too short to select an object shard');
  }
  const firstIndex = HIZOFS_OBJECT_ID_ALPHABET.indexOf(firstCharacter);
  const secondIndex = HIZOFS_OBJECT_ID_ALPHABET.indexOf(secondCharacter);
  const combinedPrefix = (
    firstIndex << HIZOFS_OBJECT_ID_CHARACTER_BIT_LENGTH
  ) | secondIndex;
  const shard = combinedPrefix >> (
    (HIZOFS_OBJECT_ID_CHARACTER_BIT_LENGTH * 2)
    - HIZOFS_OBJECT_SHARD_BIT_LENGTH
  );
  return shard.toString(16).padStart(HIZOFS_OBJECT_SHARD_HEX_LENGTH, '0');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HIZOFS_OBJECT_ID_ALPHABET,
  HIZOFS_OBJECT_ID_LENGTH,
};
