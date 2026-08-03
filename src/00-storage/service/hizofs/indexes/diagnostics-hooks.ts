import type {
  ImmutableBTreeDiagnosticOperation,
  ImmutableBTreeDiagnosticsPort,
  MutableImmutableBTreeStructuralDiagnostics,
} from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";

export { IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
export type {
  ImmutableBTreeDiagnosticOperation,
  ImmutableBTreeDiagnosticsObservation,
  ImmutableBTreeDiagnosticsPort,
  ImmutableBTreeStructuralDiagnostics,
  MutableImmutableBTreeStructuralDiagnostics,
} from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";

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
