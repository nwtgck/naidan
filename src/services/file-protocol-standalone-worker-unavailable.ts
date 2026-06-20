import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'

const unavailableMessage = 'The file-protocol standalone Worker asset is unavailable outside standalone builds.'

/**
 * Vite resolves static imports before compile-time dead-code elimination. Hosted
 * builds therefore need a concrete target for the standalone virtual module even
 * though every runtime call is guarded by __BUILD_MODE_IS_STANDALONE__.
 *
 * Fail explicitly if that boundary is violated rather than silently creating a
 * different Worker implementation in hosted mode.
 */
export async function createFileProtocolWorker(): Promise<Worker> {
  throw new Error(unavailableMessage)
}

export function getFileProtocolWorkerDiagnostics(): FileProtocolWorkerDiagnostics {
  throw new Error(unavailableMessage)
}

export function warmFileProtocolWorkerAssetAtIdle(): void {
  // Hosted builds use their native Worker entry points. This function exists
  // only so Vite can resolve and tree-shake the guarded standalone warm-up call.
}
