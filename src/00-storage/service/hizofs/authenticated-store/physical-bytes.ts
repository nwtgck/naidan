declare const authenticatedHizoFSPhysicalBytesBrand: unique symbol;

export type AuthenticatedHizoFSPhysicalBytes = Uint8Array & {
  readonly [authenticatedHizoFSPhysicalBytesBrand]: true;
};

/**
 * Allocates bytes already owned by the authenticated-store boundary.
 *
 * WHY: callers that bring existing bytes across this boundary must use the
 * copying constructor below. Internal encoders that need a fresh destination
 * can allocate the branded destination directly instead of allocating and then
 * copying the complete physical payload only to establish the same ownership.
 */
export function allocateAuthenticatedHizoFSPhysicalBytes({ byteLength }: {
  byteLength: number;
}): AuthenticatedHizoFSPhysicalBytes {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('authenticated HizoFS physical byte length must be a non-negative safe integer');
  }
  return new Uint8Array(byteLength) as AuthenticatedHizoFSPhysicalBytes;
}

export function authenticatedHizoFSPhysicalBytes({ bytes }: {
  bytes: Uint8Array;
}): AuthenticatedHizoFSPhysicalBytes {
  return Uint8Array.from(bytes) as AuthenticatedHizoFSPhysicalBytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
