import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import type {
  ITransformersJsScannerWorker,
  ScanOptions,
  TransformersJsScannerWorkerClient,
  ScannedModelFile,
} from './transformers-js.types'

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js scanner worker is not available in this environment')
}

export function createTransformersJsScannerWorkerClient(_args: EmptyArgs): TransformersJsScannerWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async scanModel(_args: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
        throw createUnavailableEnvironmentError()
      },
      async dispose(_args: EmptyArgs): Promise<void> {
      },
    }
  }

  const worker = new Worker(
    new URL('./transformers-js.scanner.worker.ts', import.meta.url),
    { type: 'module' }
  )

  const remote = Comlink.wrap<ITransformersJsScannerWorker>(worker)

  return {
    async scanModel({ tasks }: ScanOptions): Promise<{ files: ScannedModelFile[] }> {
      return remote.scanModel({ tasks })
    },
    async dispose(_args: EmptyArgs): Promise<void> {
      try {
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
