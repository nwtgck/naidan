export class HizoFSCryptoAuthenticationError extends Error {
  public readonly code = 'authentication_failed' as const;

  public constructor({ cause }: { cause: unknown }) {
    super('HizoFS cryptographic authentication failed', { cause });
    this.name = 'HizoFSCryptoAuthenticationError';
  }
}

export function isHizoFSCryptoAuthenticationError({ cause }: {
  cause: unknown;
}): boolean {
  return cause instanceof HizoFSCryptoAuthenticationError;
}

export function throwNormalizedHizoFSCryptoFailure({ cause }: { cause: unknown }): never {
  const isRawAuthenticationFailure = typeof cause === 'object'
    && cause !== null
    && 'name' in cause
    && cause.name === 'OperationError';
  if (isRawAuthenticationFailure) throw new HizoFSCryptoAuthenticationError({ cause });
  throw cause;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
