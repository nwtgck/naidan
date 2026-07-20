export class HizoFSCorruptionError extends Error {
  constructor({ message, cause }: {
    message: string;
    cause: unknown | undefined;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HizoFSCorruptionError';
  }
}

export class HizoFSPublicationOutcomeUnknownError extends Error {
  constructor({ message }: {
    message: string;
  }) {
    super(message);
    this.name = 'HizoFSPublicationOutcomeUnknownError';
  }
}

export class HizoFSUnsupportedFormatError extends Error {
  constructor({ message }: {
    message: string;
  }) {
    super(message);
    this.name = 'HizoFSUnsupportedFormatError';
  }
}

export class HizoFSCrossDeviceError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = 'CrossDeviceError';
  }

  readonly code = 'EXDEV' as const;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
