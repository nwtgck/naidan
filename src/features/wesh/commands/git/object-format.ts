import { concatBytes } from './bytes';
import { sha1Hex } from './sha1';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType,
  body: Uint8Array,
}

const textEncoder = new TextEncoder();

export function encodeObject({ type, body }: GitObject): Uint8Array {
  return concatBytes({
    chunks: [textEncoder.encode(`${type} ${body.byteLength}\0`), body],
  });
}

export function objectIdFor({ type, body }: GitObject): string {
  return sha1Hex({ bytes: encodeObject({ type, body }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
