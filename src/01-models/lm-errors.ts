/** The provider positively identified an unsupported reasoning control. */
export class UnsupportedReasoningError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = 'UnsupportedReasoningError';
  }
}

/** Worker transports reconstruct Error, not its original prototype. */
export function isUnsupportedReasoningError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === 'UnsupportedReasoningError';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
