export type BoundaryStringDiagnosticCode =
  | 'boundary-not-found'
  | 'catalog-not-found'
  | 'catalog-parse-failed'
  | 'catalog-shape-invalid'
  | 'catalog-locale-mismatch'
  | 'message-key-invalid'
  | 'message-directory-not-found'
  | 'message-directory-orphaned'
  | 'message-locale-file-missing'
  | 'unknown-message-key';

export type BoundaryStringDiagnostic = {
  code: BoundaryStringDiagnosticCode;
  message: string;
};

export class BoundaryStringDiagnosticError extends Error {
  readonly diagnostic: BoundaryStringDiagnostic;

  constructor({ diagnostic }: {
    diagnostic: BoundaryStringDiagnostic;
  }) {
    super(diagnostic.message);
    this.name = 'BoundaryStringDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

export function createBoundaryStringDiagnosticError({ code, message }: {
  code: BoundaryStringDiagnosticCode;
  message: string;
}): BoundaryStringDiagnosticError {
  return new BoundaryStringDiagnosticError({
    diagnostic: {
      code,
      message,
    },
  });
}

export function isBoundaryStringDiagnosticError(
  error: unknown,
): error is BoundaryStringDiagnosticError {
  return error instanceof BoundaryStringDiagnosticError;
}

export function createBoundaryStringDiagnosticModuleSource({ diagnostic }: {
  diagnostic: BoundaryStringDiagnostic;
}): string {
  return `\
const error = new Error(${JSON.stringify(diagnostic.message)});
error.name = "BoundaryStringDiagnosticError";
error.code = ${JSON.stringify(diagnostic.code)};
throw error;
`;
}

export function unknownMessageKeyDiagnostic({ key, moduleId }: {
  key: string;
  moduleId: string;
}): BoundaryStringDiagnostic {
  return {
    code: 'unknown-message-key',
    message: `[naidan-boundary-strings] Unknown message key "${key}" in ${moduleId}.`,
  };
}

export function unknownBoundaryDiagnostic({ boundaryId, version }: {
  boundaryId: string;
  version: string;
}): BoundaryStringDiagnostic {
  return {
    code: 'boundary-not-found',
    message: `[naidan-boundary-strings] Unknown boundary "${boundaryId}/${version}".`,
  };
}
