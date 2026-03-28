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
  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  })

  const createRuntime = async () => {
    const worker = createFileProtocolCompatibleWeshWorker()
    const remote = Comlink.wrap<IWeshWorker>(worker)
    await remote.init({ request: initRequest })
    return { worker, remote }
  }

  const destroyRuntime = async ({ worker, remote }: {
    worker: Worker
    remote: Comlink.Remote<IWeshWorker>
  }) => {
    try {
      await remote[Comlink.releaseProxy]()
    } finally {
      worker.terminate()
    }
  }

  let runtime = await createRuntime()

  return {
    async startExecution({ request, onEvent }: {
      request: WeshWorkerExecuteRequest
      onEvent?: (event: WeshWorkerExecutionEvent) => void | Promise<void>
    }) {
      const response = await runtime.remote.startExecution(
        request,
        onEvent ? Comlink.proxy(onEvent) : undefined,
      )
      return weshWorkerStartExecutionResponseSchema.parse(response)
    },
    async awaitExecution({ request }) {
      const response = await runtime.remote.awaitExecution({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interruptExecution({ request }) {
      return runtime.remote.interruptExecution({ request })
    },
    async cancelExecution({ request }) {
      const activeRuntime = runtime
      await activeRuntime.remote.interruptExecution({ request }).catch(() => false)

      const stopped = await Promise.race([
        activeRuntime.remote.awaitExecution({ request }).then(() => true).catch(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ])

      if (stopped) {
        return true
      }

      runtime = await createRuntime()
      await destroyRuntime(activeRuntime)
      return true
    },
    async disposeExecution({ request }) {
      await runtime.remote.disposeExecution({ request })
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await runtime.remote.execute({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interrupt(_args: EmptyArgs) {
      return runtime.remote.interrupt({})
    },
    async dispose(_args: EmptyArgs) {
      const activeRuntime = runtime
      try {
        await activeRuntime.remote.dispose({})
      } finally {
        await destroyRuntime(activeRuntime)
      }
    },
  }
}
