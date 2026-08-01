export type AuthenticatedStoreErrorCode =
  | "control_plane_corrupt"
  | "credential_rejected"
  | "credential_work_limit_exceeded"
  | "incomplete_container"
  | "unsupported_required_feature";

export class AuthenticatedStoreError extends Error {
  public readonly code: AuthenticatedStoreErrorCode;

  public constructor({ cause, code, message }: {
    cause?: unknown;
    code: AuthenticatedStoreErrorCode;
    message: string;
  }) {
    super(message, { cause });
    this.name = "AuthenticatedStoreError";
    this.code = code;
  }
}

export function authenticatedStoreError({ cause, code, message }: {
  cause?: unknown;
  code: AuthenticatedStoreErrorCode;
  message: string;
}): AuthenticatedStoreError {
  return new AuthenticatedStoreError({ cause, code, message });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
