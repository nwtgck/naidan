import type { ModelGraphRegistrationId } from './ids';
import { idToRaw } from './ids';
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

export function validateModelGraphRegistrations({ registrations }: { registrations: readonly ModelGraphRegistration[] }): void {
  if (registrations.length > 32) {
    throw new Error('At most 32 model graph definitions can be stored');
  }
  const ids = new Set<string>();
  let bytes = 0;
  for (const { id, label, source, sourceSha256, rule } of registrations) {
    const rawId = idToRaw({ id });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(rawId) || ids.has(rawId)) {
      throw new Error('Invalid or duplicate model graph registration');
    }
    ids.add(rawId);
    if (!label.trim() || label.length > 120) {
      throw new Error('Invalid model graph label');
    }
    const length = new TextEncoder().encode(source).byteLength;
    bytes += length;
    if (!length || length > 1024 * 1024 || bytes > 4 * 1024 * 1024) {
      throw new Error('Model graph registry size limit exceeded');
    }
    if (!/^[a-f0-9]{64}$/.test(sourceSha256) || sourceSha256 !== modelGraphSourceDigest({ source })) {
      throw new Error('Model graph source digest mismatch');
    }
    switch (rule.mode) {
    case 'disabled': break;
    case 'when_architecture_unknown': case 'replace_native':
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(rule.architecture) || rule.approvedSha256 !== sourceSha256) {
        throw new Error('Model graph approval does not match the source');
      }
      break;
    default: {
      const exhaustive: never = rule;
      throw new Error(String(exhaustive));
    }
    }
  }
}

export const TEST_ONLY = {
};
