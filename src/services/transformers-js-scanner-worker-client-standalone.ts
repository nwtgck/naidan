import type { EmptyArgs } from '@/models/types'
import type { ScanOptions, TransformersJsScannerWorkerClient, ScannedModelFile } from './transformers-js.types'

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode')
}

export function createTransformersJsScannerWorkerClient(_args: EmptyArgs): TransformersJsScannerWorkerClient {
  return {
    async scanModel(_args: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
      throw createUnsupportedError()
    },
    async dispose(_args: EmptyArgs): Promise<void> {
    },
  }
}
