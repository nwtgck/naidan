/** A synchronous immutable file source. readWithTail, when present, scatters one
 * contiguous source read into destination and then tail. Its return value counts
 * both regions; it must fill destination before putting any bytes in tail.
 * Neither supplied view may be retained after the call. */
export type ModelFileSource = {
  size: number,
  read: ({ destination, offset }: { destination: Uint8Array, offset: number }) => number,
  readWithTail?: ({ destination, offset, tail }: { destination: Uint8Array, offset: number, tail: Uint8Array }) => number,
};

export const maximumModelReadBytes = 8 * 1024 * 1024;
export const maximumModelReadTailBytes = 1024;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
