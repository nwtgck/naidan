import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleStandaloneWorkerHub } from './worker-hub-standalone-loader'
import {
  mapWeshMountsToWorkerMounts,
  weshWorkerExecuteResponseSchema,
  weshWorkerInitRequestSchema,
  type WeshWorkerClient,
  type WeshWorkerExecuteRequest,
} from './wesh-worker.types'
import type { IWorkerHub } from './worker-hub.types'
import type { WeshMount } from '@/services/wesh/types'

export async function createFileProtocolCompatibleWeshWorkerClient({
  rootHandle,
  mounts,
  user,
  initialEnv,
  initialCwd,
}: {
  rootHandle: FileSystemDirectoryHandle | 'readonly'
  mounts: WeshMount[]
  user: string
  initialEnv: Record<string, string>
  initialCwd?: string | undefined
}): Promise<WeshWorkerClient> {
  const worker = await createFileProtocolCompatibleStandaloneWorkerHub({})
  const remote = Comlink.wrap<IWorkerHub>(worker)
  const wesh = await remote.wesh

  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  })

  await wesh.init({ request: initRequest })

  return {
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await wesh.execute({ request })
      return weshWorkerExecuteResponseSchema.parse(response)
    },
    async interrupt(_args: EmptyArgs) {
      return wesh.interrupt({})
    },
    async dispose(_args: EmptyArgs) {
      try {
        await wesh.dispose({})
      } finally {
        await remote[Comlink.releaseProxy]()
        worker.terminate()
      }
    },
  }
}
