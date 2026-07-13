export class EncryptedOpfsCorruptionError extends Error {
  constructor({ message, cause }: {
    message: string;
    cause: unknown | undefined;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EncryptedOpfsCorruptionError';
  }
}

export class EncryptedOpfsUnsupportedFormatError extends Error {
  constructor({ message }: {
    message: string;
  }) {
    super(message);
    this.name = 'EncryptedOpfsUnsupportedFormatError';
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
