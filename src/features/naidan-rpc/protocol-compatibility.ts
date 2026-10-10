import { encodeProtocolHeader, inspectProtocolHeader, PROTOCOL_HEADER_BYTES } from './protocol-header';
import { NaidanRpcProtocolError } from './primitives';

/** Public, non-secret protocol identity. The transport must authenticate its returned copy. */
export function createRpcProtocolAdvertisement(): Uint8Array<ArrayBuffer> {
  return encodeProtocolHeader();
}

/** Absence is compatible; a present advertisement selects exactly this RPC profile.
 * Call only after transport authentication, never on discovery observations. */
export function validateRpcProtocolAdvertisement({ bytes }: { bytes: Uint8Array }): void {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('An owned RPC advertisement is required');
  if (bytes.length === 0) return;
  if (bytes.length > PROTOCOL_HEADER_BYTES) throw new NaidanRpcProtocolError({ diagnostic: { kind: 'malformed-advertisement', availableBytes: bytes.length } });
  const result = inspectProtocolHeader({ bytes });
  switch (result.kind) {
  case 'supported': return;
  case 'truncated-header': case 'wrong-protocol-magic': case 'invalid-protocol-version': case 'unsupported-protocol-version': throw new NaidanRpcProtocolError({ diagnostic: result });
  default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
