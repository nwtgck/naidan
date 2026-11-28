import type { ModelGraphRegistrationId } from './ids';
import { createSha256Hasher } from '@/utils/sha256';

export type ModelGraphUseRule =
  | { mode: 'disabled' }
  | { mode: 'when_architecture_unknown' | 'replace_native'; architecture: string; approvedSha256: string };

/** Source syntax is deliberately experimental and may break between releases.
 * Retain unreadable source for recovery; never convert a broken override into
 * permission to run the native architecture instead. */
export type ModelGraphRegistration = {
  id: ModelGraphRegistrationId,
  label: string,
  source: string,
  sourceSha256: string,
  rule: ModelGraphUseRule,
};

export function modelGraphSourceDigest({ source }: { source: string }): string {
  const hasher = createSha256Hasher();
  hasher.update({ bytes: new TextEncoder().encode(source) });
  return hasher.digestHex();
}

export const TEST_ONLY = {
};
