import type { StandaloneWorkerRuntimeDiagnostics } from './standalone-worker-runtime.types';

const unavailableMessage = 'The file-protocol standalone Worker runtime is unavailable outside standalone builds.';

/**
 * Vite resolves static imports before compile-time dead-code elimination. Hosted
 * builds therefore need a concrete target for the standalone runtime virtual
 * module even though every runtime call is guarded by __BUILD_MODE_IS_STANDALONE__.
 */
export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics {
  throw new Error(unavailableMessage);
}

export function scheduleStandaloneWorkerBootstrapWarmup(): void {
  // Hosted mode uses native Worker entry points. This exists only so Vite can
  // resolve and tree-shake the guarded standalone warmup import.
}

export function disposeStandaloneWorkerBootstrap(): void {
  // No standalone bootstrap exists outside standalone mode.
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
