import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleStandaloneWorkerHub } from './worker-hub-standalone-loader'
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
  weshWorkerExecutionSummarySchema,
  mapWeshMountsToWorkerMounts,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerInitRequestSchema,
  type WeshWorkerClient,
  type WeshWorkerExecutionEvent,
  type WeshWorkerExecuteRequest,
  type WeshWorkerRemoteExecutionEvent,
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
  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  })

  const createRuntime = async () => {
    const worker = await createFileProtocolCompatibleStandaloneWorkerHub({})
    const remote = Comlink.wrap<IWorkerHub>(worker)
    const wesh = await remote.wesh
    await wesh.init({ request: initRequest })
    return { worker, remote, wesh }
  }

  const destroyRuntime = async ({ worker, remote }: {
    worker: Worker
    remote: Comlink.Remote<IWorkerHub>
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
      const response = await runtime.wesh.startExecution(
        request,
        onEvent ? Comlink.proxy(async (event: WeshWorkerRemoteExecutionEvent) => {
          await onEvent(mapRemoteWeshWorkerExecutionEventToClientEvent({ event }))
        }) : undefined,
      )
      return weshWorkerStartExecutionResponseSchema.parse(response)
    },
    async awaitExecution({ request }) {
      const response = await runtime.wesh.awaitExecution({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interruptExecution({ request }) {
      return runtime.wesh.interruptExecution({ request })
    },
    async cancelExecution({ request }) {
      const activeRuntime = runtime
      await activeRuntime.wesh.interruptExecution({ request }).catch(() => false)

      const completionSettled = activeRuntime.wesh.awaitExecution({ request }).then(() => true).catch(() => true)
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
          console.error('Failed to destroy cancelled standalone Wesh worker runtime', error)
        })
      })
      return true
    },
    async disposeExecution({ request }) {
      await runtime.wesh.disposeExecution({ request })
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await runtime.wesh.execute({ request })
      return weshWorkerExecutionSummarySchema.parse(response)
    },
    async interrupt(_args: EmptyArgs) {
      return runtime.wesh.interrupt({})
    },
    async dispose(_args: EmptyArgs) {
      const activeRuntime = runtime
      try {
        await activeRuntime.wesh.dispose({})
      } finally {
        await destroyRuntime(activeRuntime)
      }
    },
  }
}
