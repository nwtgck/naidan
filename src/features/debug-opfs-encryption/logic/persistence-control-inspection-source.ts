import type { PersistenceControlInspection } from "@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types";

/**
 * Read-only one-shot boundary for the debug surface.
 *
 * The source owns physical I/O and proof authority. The modal only receives a
 * detached inspection result, so it cannot fabricate proof-valid state or keep
 * root-key capabilities alive between refreshes.
 */
export interface PersistenceControlInspectionSource {
  inspectPersistenceControl(): Promise<PersistenceControlInspection>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
