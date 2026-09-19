import { concatBytes } from './bytes';
import { createSha1Hasher } from './sha1';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType,
  body: Uint8Array,
}

const textEncoder = new TextEncoder();

export function encodeObjectHeader({ type, bodyByteLength }: {
  type: GitObjectType,
  bodyByteLength: number,
}): Uint8Array {
  return textEncoder.encode(`${type} ${bodyByteLength}\0`);
}

export function encodeObject({ type, body }: GitObject): Uint8Array {
  return concatBytes({
    chunks: [encodeObjectHeader({ type, bodyByteLength: body.byteLength }), body],
  });
}

export function objectIdFor({ type, body }: GitObject): string {
  const hasher = createSha1Hasher();
  hasher.update({ bytes: encodeObjectHeader({ type, bodyByteLength: body.byteLength }) });
  hasher.update({ bytes: body });
  return hasher.digestHex();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
