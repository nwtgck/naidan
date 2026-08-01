import { HIZOFS_V1_FORMAT_CONSTANTS } from './v1';

// Public compatibility surface for reviewed HizoFS format consumers. Production
// modules outside 00-format import this entry point rather than deep codec paths.
export * from './v1';

export type HizoFSV1PersistedRecordKindDiagnosticName =
  keyof typeof HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

/**
 * Exposes only canonical record-kind names for diagnostics. Numeric values
 * remain private format authority and must not be duplicated by consumers.
 */
export const HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES = Object.freeze(
  Object.keys(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds) as HizoFSV1PersistedRecordKindDiagnosticName[],
);

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
