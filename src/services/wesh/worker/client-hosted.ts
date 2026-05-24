import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME } from '@/models/constants'
import { createNaidanSysfsRemoteReaderForMounts } from '@/services/wesh/naidan-sysfs/storage-reader'
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
  weshWorkerExecutionSummarySchema,
  mapWeshMountsToWorkerMounts,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerInitRequestSchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecutionEvent,
  type WeshWorkerExecuteRequest,
  type WeshWorkerRemoteExecutionEvent,
} from './types'
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
  const naidanSysfsRemoteReader = createNaidanSysfsRemoteReaderForMounts({ mounts })
  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  })

  const createRuntime = async () => {
    const worker = new Worker(
      new URL('./entry.ts', import.meta.url),
      {
        type: 'module',
        name: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
      },
    )
    const remote = Comlink.wrap<IWeshWorker>(worker)
    // Keep the proxied reader as a separate top-level argument.
    // Putting it inside the init request object can fail structured clone in browsers.
    await remote.init(
      initRequest,
      naidanSysfsRemoteReader
        ? Comlink.proxy(naidanSysfsRemoteReader)
        : undefined,
    )
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
        onEvent ? Comlink.proxy(async (event: WeshWorkerRemoteExecutionEvent) => {
          await onEvent(mapRemoteWeshWorkerExecutionEventToClientEvent({ event }))
        }) : undefined,
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

      const completionSettled = activeRuntime.remote.awaitExecution({ request }).then(() => true).catch(() => true)
      const stopped = await Promise.race([
        completionSettled,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ])

      if (stopped) {
        return true
      }

      runtime = await createRuntime()
      void completionSettled.finally(() => {
        void destroyRuntime(activeRuntime).catch(error => {
          console.error('Failed to destroy cancelled Wesh worker runtime', error)
        })
      })
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
