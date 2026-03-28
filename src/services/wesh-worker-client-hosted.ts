import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleWeshWorker } from '@/services/wesh-worker-loader'
import {
  weshWorkerExecutionSummarySchema,
  mapWeshMountsToWorkerMounts,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerInitRequestSchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecutionEvent,
  type WeshWorkerExecuteRequest,
} from './wesh-worker.types'
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
  const worker = createFileProtocolCompatibleWeshWorker()
  const remote = Comlink.wrap<IWeshWorker>(worker)

  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  })

  await remote.init({ request: initRequest })

  return {
    async startExecution({ request, onEvent }: {
      request: WeshWorkerExecuteRequest
      onEvent?: (event: WeshWorkerExecutionEvent) => void | Promise<void>
    }) {
      const response = await remote.startExecution(
        request,
        onEvent ? Comlink.proxy(onEvent) : undefined,
      )
      return weshWorkerStartExecutionResponseSchema.parse(response)
    },
    async awaitExecution({ request }) {
      const response = await remote.awaitExecution({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interruptExecution({ request }) {
      return remote.interruptExecution({ request })
    },
    async disposeExecution({ request }) {
      await remote.disposeExecution({ request })
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await remote.execute({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interrupt(_args: EmptyArgs) {
      return remote.interrupt({})
    },
    async dispose(_args: EmptyArgs) {
      try {
        await remote.dispose({})
      } finally {
        await remote[Comlink.releaseProxy]()
        worker.terminate()
      }
    },
  }
}
