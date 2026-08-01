export type ImmutableBTreeDiagnosticOperation = "build" | "update";

export type ImmutableBTreeDiagnosticsObservation = Readonly<{
  durationMs: number;
  operation: ImmutableBTreeDiagnosticOperation;
}>;

/**
 * Receives timing for one complete immutable B+tree operation. Keys, entries,
 * pages, and references stay inside the index owner; only operation kind and
 * elapsed time cross the diagnostics boundary.
 */
export type ImmutableBTreeDiagnosticsPort = Readonly<{
  recordIndexOperation: ({
    durationMs,
    operation,
  }: ImmutableBTreeDiagnosticsObservation) => void;
}>;

export async function measureImmutableBTreeOperation<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  operation,
  run,
}: {
  clock?: () => number;
  diagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  operation: ImmutableBTreeDiagnosticOperation;
  run: () => Promise<T>;
}): Promise<T> {
  if (diagnostics === undefined) return await run();
  const startedAt = clock();
  try {
    return await run();
  } finally {
    diagnostics.recordIndexOperation({
      durationMs: Math.max(0, clock() - startedAt),
      operation,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
