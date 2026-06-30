import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub';

const unavailableMessage = 'The file-protocol standalone Worker asset is unavailable outside standalone builds.';

/**
 * Vite resolves static imports before compile-time dead-code elimination. Hosted
 * builds therefore need a concrete target for the standalone virtual module even
 * though every runtime call is guarded by __BUILD_MODE_IS_STANDALONE__.
 *
 * Fail explicitly if that boundary is violated rather than silently creating a
 * different Worker implementation in hosted mode.
 */
export async function createFileProtocolStandaloneWorker(): Promise<Worker> {
  throw new Error(unavailableMessage);
}

export function debugGetFileProtocolStandaloneWorkerDiagnostics(): DebugFileProtocolStandaloneWorkerDiagnostics {
  throw new Error(unavailableMessage);
}

export function scheduleFileProtocolStandaloneWorkerAssetWarmup(): void {
  // Hosted builds use their native Worker entry points. This function exists
  // only so Vite can resolve and tree-shake the guarded standalone warm-up call.
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
