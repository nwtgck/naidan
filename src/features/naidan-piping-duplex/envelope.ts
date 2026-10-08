import { encodeProtocolHeader, inspectProtocolHeader } from './protocol-header';
import type { ProtocolHeaderResult } from './protocol-header';
import { equalBytes, joinBytes, ownBytes, requireValue } from './bytes';

export const PUBLIC_HANDSHAKE_BYTES = 256;
export const PRIVATE_HANDSHAKE_BYTES = 463;
export const JOURNAL_BYTES = 8368;
export const JOURNAL_PREFIX_BYTES = 46;
export const JOURNAL_FIXED_BYTES = 112;
export type DiscoveryPacket =
  | { kind: 'offer'; attemptI: Uint8Array; publicData: Uint8Array; bytes: Uint8Array }
  | { kind: 'reply'; attemptI: Uint8Array; attemptR: Uint8Array; publicData: Uint8Array; bytes: Uint8Array }
  | { kind: 'hint'; attemptI: Uint8Array; version: number }
  | { kind: 'unsupported-offer'; attemptI: Uint8Array; version: number }
  | { kind: 'unsupported-reply'; attemptI: Uint8Array; version: number }
  | { kind: 'observation'; header: ProtocolHeaderResult | { kind: 'malformed-payload' } };

export function encodeDiscovery({ kind, attemptI, attemptR, publicData }: {
  kind: 'offer' | 'reply'; attemptI: Uint8Array; attemptR?: Uint8Array; publicData: Uint8Array;
}): Uint8Array<ArrayBuffer> {
  const data = ownBytes({ bytes: publicData, maxBytes: PUBLIC_HANDSHAKE_BYTES });
  requireValue({ condition: attemptI.length === 32 && attemptI.some(Boolean), message: 'Discovery attempt' });
  const prefix = (() => {
    switch (kind) {
    case 'offer': return joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([1]), attemptI] });
    case 'reply':
      requireValue({ condition: attemptR?.length === 32 && attemptR.some(Boolean), message: 'Reply attempt' });
      return joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([2]), attemptI, attemptR!] });
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
  })();
  const length = new Uint8Array(2); new DataView(length.buffer).setUint16(0, data.length, true);
  return joinBytes({ parts: [prefix, length, data] });
}
export function encodeHint({ attemptI }: { attemptI: Uint8Array }): Uint8Array<ArrayBuffer> {
  requireValue({ condition: attemptI.length === 32 && attemptI.some(Boolean), message: 'Hint attempt' });
  return joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([3]), attemptI] });
}
/** Unknown revisions expose only the frozen kind/attempt prefix, never their payload. */
export function inspectDiscovery({ bytes }: { bytes: Uint8Array }): DiscoveryPacket {
  const header = inspectProtocolHeader({ bytes, maxBytes: 336 });
  switch (header.kind) {
  case 'oversized-message': return { kind: 'observation', header: { kind: 'malformed-payload' } };
  case 'truncated-header': case 'wrong-protocol-magic': case 'invalid-protocol-version': return { kind: 'observation', header };
  case 'supported': case 'unsupported-protocol-version': break;
  default: { const exhaustive: never = header; throw new Error(String(exhaustive)); }
  }
  if (bytes.length < 46 || !bytes.subarray(14, 46).some(Boolean)) return { kind: 'observation', header: { kind: 'malformed-payload' } };
  const attemptI = bytes.slice(14, 46), kind = bytes[13];
  if (kind === 3 && bytes.length === 46) return { kind: 'hint', attemptI, version: header.version };
  switch (header.kind) {
  case 'supported': break;
  case 'unsupported-protocol-version': {
    // Conservative answer policy, not validation of a future revision's body.
    if (kind === 1 && bytes.length >= 48 && bytes.length <= 304) return { kind: 'unsupported-offer', attemptI, version: header.version };
    if (kind === 2 && bytes.length >= 78 && bytes.subarray(46, 78).some(Boolean)) return { kind: 'unsupported-reply', attemptI, version: header.version };
    return { kind: 'observation', header };
  }
  default: { const exhaustive: never = header; throw new Error(String(exhaustive)); }
  }
  const at = kind === 1 ? 46 : kind === 2 ? 78 : undefined;
  if (at === undefined || bytes.length < at + 2) return { kind: 'observation', header: { kind: 'malformed-payload' } };
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);
  if (length > PUBLIC_HANDSHAKE_BYTES || bytes.length !== at + 2 + length) return { kind: 'observation', header: { kind: 'malformed-payload' } };
  const publicData = bytes.slice(at + 2), owned = bytes.slice();
  if (kind === 1) return { kind: 'offer', attemptI, publicData, bytes: owned };
  const attemptR = bytes.slice(46, 78);
  if (!attemptR.some(Boolean)) return { kind: 'observation', header: { kind: 'malformed-payload' } };
  return { kind: 'reply', attemptI, attemptR, publicData, bytes: owned };
}
export function journalBody({ bytes }: { bytes: Uint8Array }): Uint8Array | undefined {
  const header = inspectProtocolHeader({ bytes, maxBytes: JOURNAL_BYTES });
  if (header.kind !== 'supported' || bytes[13] !== 4 || bytes.length < JOURNAL_FIXED_BYTES || !bytes.subarray(14, 46).some(Boolean)) return undefined;
  return bytes.subarray(JOURNAL_PREFIX_BYTES);
}
export function selectedChallenge({ bytes, attemptI, attemptR }: {
  bytes: Uint8Array; attemptI: Uint8Array; attemptR: Uint8Array;
}): Uint8Array | undefined {
  const body = journalBody({ bytes });
  if (!body || bytes.length !== JOURNAL_FIXED_BYTES || body[0] !== 1 || body[65] !== 0 ||
    !equalBytes({ left: body.subarray(1, 33), right: attemptI }) || !equalBytes({ left: body.subarray(33, 65), right: attemptR })) return undefined;
  return bytes.slice(14, 46);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
