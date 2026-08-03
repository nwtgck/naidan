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

function emptyStructuralDiagnostics(): MutableImmutableBTreeStructuralDiagnostics {
  return {
    inputMutations: 0,
    maximumPageLevel: 0,
    pageReads: 0,
    pageWrites: 0,
    rootCollapses: 0,
    splitOperations: 0,
    splitOutputPages: 0,
    unchangedPageReuses: 0,
  };
}

export async function measureImmutableBTreeOperation<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  operation,
  run,
}: {
  clock?: () => number;
  diagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  operation: ImmutableBTreeDiagnosticOperation;
  run: ({ structural }: { structural: MutableImmutableBTreeStructuralDiagnostics | undefined }) => Promise<T>;
}): Promise<T> {
  if (diagnostics === undefined) return await run({ structural: undefined });
  const structural = emptyStructuralDiagnostics();
  const startedAt = clock();
  try {
    return await run({ structural });
  } finally {
    diagnostics.recordIndexOperation({
      durationMs: Math.max(0, clock() - startedAt),
      operation,
      structural,
    });
  }
}

export async function* measureImmutableBTreeIteration<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  operation,
  run,
}: {
  clock?: () => number;
  diagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  operation: ImmutableBTreeDiagnosticOperation;
  run: ({ structural }: { structural: MutableImmutableBTreeStructuralDiagnostics | undefined }) => AsyncIterable<T>;
}): AsyncIterable<T> {
  if (diagnostics === undefined) {
    yield* run({ structural: undefined });
    return;
  }
  const structural = emptyStructuralDiagnostics();
  const startedAt = clock();
  try {
    yield* run({ structural });
  } finally {
    diagnostics.recordIndexOperation({
      durationMs: Math.max(0, clock() - startedAt),
      operation,
      structural,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
