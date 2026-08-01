declare const authenticatedHizoFSPhysicalBytesBrand: unique symbol;

export type AuthenticatedHizoFSPhysicalBytes = Uint8Array & {
  readonly [authenticatedHizoFSPhysicalBytesBrand]: true;
};

export function authenticatedHizoFSPhysicalBytes({ bytes }: {
  bytes: Uint8Array;
}): AuthenticatedHizoFSPhysicalBytes {
  return Uint8Array.from(bytes) as AuthenticatedHizoFSPhysicalBytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
