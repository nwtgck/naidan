import {
  createFileProtocolStandaloneWorker,
  debugGetFileProtocolStandaloneWorkerDiagnostics,
  scheduleFileProtocolStandaloneWorkerAssetWarmup,
} from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub';
import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub';
import { FILE_PROTOCOL_STANDALONE_WORKER_HUB_NAME } from '@/constants';

export async function createFileProtocolStandaloneWorkerHub(): Promise<Worker> {
  return createFileProtocolStandaloneWorker({
    name: FILE_PROTOCOL_STANDALONE_WORKER_HUB_NAME,
  });
}

export function scheduleFileProtocolStandaloneWorkerHubWarmup(): void {
  scheduleFileProtocolStandaloneWorkerAssetWarmup();
}

export function debugGetFileProtocolStandaloneWorkerHubDiagnostics(): DebugFileProtocolStandaloneWorkerDiagnostics {
  return debugGetFileProtocolStandaloneWorkerDiagnostics();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
