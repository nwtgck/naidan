import {
  createFileProtocolWorker,
  getFileProtocolWorkerDiagnostics,
  warmFileProtocolWorkerAssetAtIdle,
} from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import type { FileProtocolWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-compatible-standalone-worker-hub'
import { FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME } from '@/models/constants'

export async function createFileProtocolCompatibleStandaloneWorkerHub(): Promise<Worker> {
  return createFileProtocolWorker({
    name: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME,
  })
}

export function warmFileProtocolCompatibleStandaloneWorkerHubAssetAtIdle(): void {
  warmFileProtocolWorkerAssetAtIdle()
}

export function getFileProtocolCompatibleStandaloneWorkerHubDiagnostics(): FileProtocolWorkerDiagnostics {
  return getFileProtocolWorkerDiagnostics()
}
