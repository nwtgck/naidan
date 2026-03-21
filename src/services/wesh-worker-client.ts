import * as Comlink from 'comlink'
import { createFileProtocolCompatibleWeshWorker } from '@/services/wesh-worker-loader'
import {
  mapWeshMountsToWorkerMounts,
  weshWorkerExecuteResponseSchema,
  weshWorkerInitRequestSchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecuteRequest,
} from './wesh-worker.types'
import type { WeshMount } from '@/services/wesh/types'

export async function createFileProtocolCompatibleWeshWorkerClient({
  rootHandle,
  mounts,
  user,
  initialEnv,
}: {
  rootHandle: FileSystemDirectoryHandle
  mounts: WeshMount[]
  user: string
  initialEnv: Record<string, string>
}): Promise<WeshWorkerClient> {
  const worker = createFileProtocolCompatibleWeshWorker()
  const remote = Comlink.wrap<IWeshWorker>(worker)

  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
  })

  await remote.init({ request: initRequest })

  return {
    // TODO: Move this client surface to a standalone worker hub and migrate transformers loaders to the same pattern.
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await remote.execute({ request })
      return weshWorkerExecuteResponseSchema.parse(response)
    },
    async interrupt() {
      return remote.interrupt()
    },
    async dispose() {
      try {
        await remote.dispose()
      } finally {
        remote[Comlink.releaseProxy]()
        worker.terminate()
      }
    },
  }
}
