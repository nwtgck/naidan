export const PHYSICAL_STORE_ERROR_CODES = [
  'already_exists',
  'closed_handle',
  'durability_not_demonstrated',
  'file_open',
  'file_too_large',
  'foreign_handle',
  'is_directory',
  'not_directory',
  'not_found',
  'out_of_range',
  'sync_access_unavailable',
  'unexpected_end',
  'write_stalled',
] as const;

export type PhysicalStoreErrorCode = typeof PHYSICAL_STORE_ERROR_CODES[number];

export class PhysicalStoreError extends Error {
  public readonly code: PhysicalStoreErrorCode;
  public readonly path: string | undefined;

  public constructor({ code, message, path }: {
    code: PhysicalStoreErrorCode;
    message: string;
    path?: string;
  }) {
    super(message);
    this.name = 'PhysicalStoreError';
    this.code = code;
    this.path = path;
  }
}

export function physicalStoreError({ code, message, path }: {
  code: PhysicalStoreErrorCode;
  message: string;
  path?: string;
}): PhysicalStoreError {
  return new PhysicalStoreError({ code, message, path });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
