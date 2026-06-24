import {
  createFileProtocolStandaloneWorker,
  debugGetFileProtocolStandaloneWorkerDiagnostics,
  scheduleFileProtocolStandaloneWorkerAssetWarmup,
} from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub'
import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub'
import { FILE_PROTOCOL_STANDALONE_WORKER_HUB_NAME } from '@/models/constants'

export async function createFileProtocolStandaloneWorkerHub(): Promise<Worker> {
  return createFileProtocolStandaloneWorker({
    name: FILE_PROTOCOL_STANDALONE_WORKER_HUB_NAME,
  })
}

export function scheduleFileProtocolStandaloneWorkerHubWarmup(): void {
  scheduleFileProtocolStandaloneWorkerAssetWarmup()
}

export function debugGetFileProtocolStandaloneWorkerHubDiagnostics(): DebugFileProtocolStandaloneWorkerDiagnostics {
  return debugGetFileProtocolStandaloneWorkerDiagnostics()
}
