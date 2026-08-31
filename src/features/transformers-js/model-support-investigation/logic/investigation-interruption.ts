export class ModelSupportInvestigationUserInterruptedError extends Error {
  constructor() {
    super("Model Support Investigation was stopped by the user");
    this.name = "ModelSupportInvestigationUserInterruptedError";
  }
}

export function isModelSupportInvestigationUserInterruptedError({ error }: {
  error: unknown,
}): boolean {
  return error instanceof ModelSupportInvestigationUserInterruptedError;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};