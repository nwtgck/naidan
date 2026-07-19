import {
  decodeHizoFSObjectReference,
  getHizoFSObjectReferenceShard,
} from '@/00-storage/service/hizofs/segment-store/object-reference';

export function validateHizoFSObjectId({ objectId }: {
  objectId: string;
}): void {
  decodeHizoFSObjectReference({ value: objectId });
}

export function getHizoFSObjectShard({ objectId }: {
  objectId: string;
}): string {
  return getHizoFSObjectReferenceShard({ objectId });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
