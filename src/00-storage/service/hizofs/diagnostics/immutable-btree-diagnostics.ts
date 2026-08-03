export const IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS = Object.freeze([
  "build",
  "entries",
  "entries_from_floor",
  "get",
  "seek_floor",
  "update",
  "validate_structure",
] as const);

export type ImmutableBTreeDiagnosticOperation = typeof IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS[number];

export type ImmutableBTreeStructuralDiagnostics = Readonly<{
  inputMutations: number;
  maximumPageLevel: number;
  pageReads: number;
  pageWrites: number;
  rootCollapses: number;
  splitOperations: number;
  splitOutputPages: number;
  unchangedPageReuses: number;
}>;

export type MutableImmutableBTreeStructuralDiagnostics = {
  -readonly [K in keyof ImmutableBTreeStructuralDiagnostics]: ImmutableBTreeStructuralDiagnostics[K];
};

export type ImmutableBTreeDiagnosticsObservation = Readonly<{
  durationMs: number;
  operation: ImmutableBTreeDiagnosticOperation;
  structural: ImmutableBTreeStructuralDiagnostics;
}>;

/**
 * Receives bounded aggregate measurements for one complete immutable B+tree
 * operation. Keys, entries, pages, and references stay inside the index owner;
 * only counts, page-level high-water, operation kind, and elapsed time cross the
 * diagnostics boundary.
 */
export type ImmutableBTreeDiagnosticsPort = Readonly<{
  recordIndexOperation: ({
    durationMs,
    operation,
    structural,
  }: ImmutableBTreeDiagnosticsObservation) => void;
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
