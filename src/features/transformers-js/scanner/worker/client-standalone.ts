
import type { ScanOptions, TransformersJsScannerWorkerClient, ScannedModelFile } from '@/features/transformers-js/types';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export function createTransformersJsScannerWorkerClient(): TransformersJsScannerWorkerClient {
  return {
    async scanModel({ tasks: _tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
      throw createUnsupportedError();
    },
    async dispose(): Promise<void> {
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
