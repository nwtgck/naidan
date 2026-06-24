import { z } from 'zod'
import * as Comlink from 'comlink'

import { createFileProtocolStandaloneWorkerHub } from '@/services/worker-hub-standalone-loader'
import { createNaidanSysfsRemoteReaderForMounts } from '@/services/wesh/naidan-sysfs/storage-reader'
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
  weshWorkerExecutionSummarySchema,
  mapWeshMountsToWorkerMounts,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerInitRequestSchema,
  weshWorkerShellStateSchema,
  weshWorkerCommandEntrySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerDirectoryEntrySchema,
  type WeshWorkerClient,
  type WeshWorkerExecutionEventCallback,
  type WeshWorkerExecuteRequest,
  type WeshWorkerRemoteExecutionEvent,
} from './types'
import type { IWorkerHub } from '@/services/worker-hub.types'
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
    const worker = await createFileProtocolStandaloneWorkerHub()
    const remote = Comlink.wrap<IWorkerHub>(worker)
    const wesh = await remote.wesh
    // Keep the proxied reader as a separate top-level argument.
    // Putting it inside the init request object can fail structured clone in browsers.
    await wesh.init(
      initRequest,
      naidanSysfsRemoteReader
        ? Comlink.proxy(naidanSysfsRemoteReader)
        : undefined,
    )
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
      onEvent?: WeshWorkerExecutionEventCallback
    }) {
      const response = await runtime.wesh.startExecution(
        request,
        onEvent ? Comlink.proxy(async (event: WeshWorkerRemoteExecutionEvent) => {
          await onEvent({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) })
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
    async getShellState() {
      const response = await runtime.wesh.getShellState()
      return weshWorkerShellStateSchema.parse(response)
    },
    async listCommands() {
      const response = await runtime.wesh.listCommands()
      return z.array(weshWorkerCommandEntrySchema).parse(response)
    },
    async listDirectory({ request }) {
      const validated = weshWorkerListDirectoryRequestSchema.parse(request)
      const response = await runtime.wesh.listDirectory({ request: validated })
      return z.array(weshWorkerDirectoryEntrySchema).parse(response)
    },
    async interrupt() {
      return runtime.wesh.interrupt()
    },
    async dispose() {
      const activeRuntime = runtime
      try {
        await activeRuntime.wesh.dispose()
      } finally {
        await destroyRuntime(activeRuntime)
      }
    },
  }
}
