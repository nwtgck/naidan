export type HizoFSRuntimePolicy = Readonly<{
  maxDirectoryIteratorEntries: number;
  maxHeldLockNames: number;
  maxMaintenanceRootRegistrations: number;
  maxReaderPins: number;
  maxSegmentReferences: number;
}>;

export type HizoFSRuntimePolicyErrorCode =
  | "invalid_runtime_limit";

export class HizoFSRuntimePolicyError extends Error {
  readonly code: HizoFSRuntimePolicyErrorCode;

  constructor({ code, message }: {
    code: HizoFSRuntimePolicyErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "HizoFSRuntimePolicyError";
    this.code = code;
  }
}

function validateLimit({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HizoFSRuntimePolicyError({
      code: "invalid_runtime_limit",
      message: `${name} must be a positive safe integer`,
    });
  }
}

/**
 * Runtime tuning is deliberately explicit and never persisted. Validating all
 * bounds at composition time prevents a typo from silently disabling memory
 * limits in a later iterator, pin, segment, or browser-lock code path.
 */
export function createRuntimePolicy({
  maxDirectoryIteratorEntries,
  maxHeldLockNames,
  maxMaintenanceRootRegistrations,
  maxReaderPins,
  maxSegmentReferences,
}: HizoFSRuntimePolicy): HizoFSRuntimePolicy {
  validateLimit({ name: "maxDirectoryIteratorEntries", value: maxDirectoryIteratorEntries });
  validateLimit({ name: "maxHeldLockNames", value: maxHeldLockNames });
  validateLimit({ name: "maxMaintenanceRootRegistrations", value: maxMaintenanceRootRegistrations });
  validateLimit({ name: "maxReaderPins", value: maxReaderPins });
  validateLimit({ name: "maxSegmentReferences", value: maxSegmentReferences });
  return Object.freeze({
    maxDirectoryIteratorEntries,
    maxHeldLockNames,
    maxMaintenanceRootRegistrations,
    maxReaderPins,
    maxSegmentReferences,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
