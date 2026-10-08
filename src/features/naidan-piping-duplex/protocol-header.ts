/** The preamble is independent of payload framing and does not authenticate a peer. */
export const PROTOCOL_HEADER_BYTES = 13;
export const PROTOCOL_VERSION = 0x80000002;
const MAGIC = [0, 110, 97, 105, 100, 97, 110, 112, 100] as const;

/** These are local observations, never instructions to downgrade or block a peer. */
export type ProtocolHeaderResult =
  | { readonly kind: 'supported'; readonly version: number }
  | { readonly kind: 'truncated-header'; readonly availableBytes: number }
  | { readonly kind: 'wrong-protocol-magic' }
  | { readonly kind: 'invalid-protocol-version'; readonly version: number }
  | { readonly kind: 'unsupported-protocol-version'; readonly version: number };

function requireBytes({ bytes }: { bytes: Uint8Array }): void {
  // Concurrent mutation cannot be made safe by a synchronous prefix check.
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    throw new TypeError('A non-shared Uint8Array is required');
  }
}

/** Always creates an owned header for the single supported profile; no negotiation. */
export function encodeProtocolHeader(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(PROTOCOL_HEADER_BYTES);
  bytes.set(MAGIC);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(9, PROTOCOL_VERSION, true);
  return bytes;
}

/** Reads only the preamble. A supported header does not validate the following payload.
 * No input bytes are retained or returned. Short input here means definitive EOF. */
export function inspectProtocolHeader({ bytes, maxBytes }: {
  bytes: Uint8Array;
  maxBytes: number;
}): ProtocolHeaderResult | { readonly kind: 'oversized-message' } {
  requireBytes({ bytes });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < PROTOCOL_HEADER_BYTES) {
    throw new RangeError('Finite body limit must be a safe integer of at least 13 bytes');
  }
  // Check the containing phase's cap before inspecting or copying any header/body bytes.
  if (bytes.byteLength > maxBytes) return { kind: 'oversized-message' };
  if (bytes.byteLength < PROTOCOL_HEADER_BYTES) {
    return { kind: 'truncated-header', availableBytes: bytes.byteLength };
  }
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    return { kind: 'wrong-protocol-magic' };
  }
  // The version starts at an unaligned offset, potentially within a larger buffer.
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(9, true);
  if ((version & 0x7fffffff) === 0) return { kind: 'invalid-protocol-version', version };
  if (version !== PROTOCOL_VERSION) return { kind: 'unsupported-protocol-version', version };
  return { kind: 'supported', version };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
