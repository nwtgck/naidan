import * as Comlink from 'comlink';

import type {
  ITransformersJsScannerWorker,
  ScanOptions,
  TransformersJsScannerWorkerClient,
  ScannedModelFile,
} from '@/features/transformers-js/types';

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js scanner worker is not available in this environment');
}

export function createTransformersJsScannerWorkerClient(): TransformersJsScannerWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async scanModel({ tasks: _tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
        throw createUnavailableEnvironmentError();
      },
      async dispose(): Promise<void> {
      },
    };
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    { type: 'module' },
  );

  const remote = Comlink.wrap<ITransformersJsScannerWorker>(worker);

  return {
    async scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
      return remote.scanModel({ tasks });
    },
    async dispose(): Promise<void> {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
