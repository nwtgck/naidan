import { FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME } from '@/models/constants'

export function createFileProtocolCompatibleWeshWorker(): Worker {
  return new Worker(
    new URL('./wesh.worker.ts', import.meta.url),
    {
      type: 'module',
      name: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
    }
  )
}
