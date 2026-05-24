import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { Wesh } from '@/services/wesh'
import { NaidanSysfsProvider } from '@/services/wesh/naidan-sysfs/provider'
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/services/wesh/naidan-sysfs/storage-reader'
import { ReadonlyDirectoryHandle } from '@/services/wesh/readonly-directory-handle'
import { createTestReadHandleFromText } from '@/services/wesh/utils/test-stream'
import { createWriteHandleFromStream } from '@/services/wesh/utils/stream'
import {
  weshWorkerAwaitExecutionRequestSchema,
  weshWorkerDisposeExecutionRequestSchema,
  weshWorkerExecuteRequestSchema,
  weshWorkerExecutionSummarySchema,
  weshWorkerInitRequestSchema,
  weshWorkerInterruptExecutionRequestSchema,
  weshWorkerStartExecutionResponseSchema,
  type IWeshWorker,
  type WeshWorkerRemoteExecutionEvent,
  type WeshWorkerExecutionSummary,
} from './types'

function createForwardingHandle({
  stream,
  onEvent,
}: {
  stream: 'stdout' | 'stderr'
  onEvent: (event: WeshWorkerRemoteExecutionEvent) => Promise<void>
}) {
  const toTransferableBuffer = ({ chunk }: {
    chunk: Uint8Array
  }): ArrayBuffer => {
    if (
      chunk.byteOffset === 0
      && chunk.byteLength === chunk.buffer.byteLength
      && chunk.buffer instanceof ArrayBuffer
    ) {
      return chunk.buffer
    }
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
  }

  const handle = createWriteHandleFromStream({
    target: new WritableStream({
      async write(chunk) {
        const buffer = toTransferableBuffer({ chunk })

        await onEvent(Comlink.transfer({
          type: stream,
          buffer,
        }, [buffer]))
      },
    }),
  })

  return {
    handle,
  }
}

export function createWeshWorker(_args: EmptyArgs): IWeshWorker {
  let wesh: Wesh | undefined
  let nextExecutionId = 1
  const executions = new Map<string, {
    completion: Promise<WeshWorkerExecutionSummary>
  }>()

  return {
    async init({ request }) {
      const validated = weshWorkerInitRequestSchema.parse(request)
      const rootHandle = validated.rootHandle === 'readonly'
        ? new ReadonlyDirectoryHandle()
        : validated.rootHandle

      wesh = new Wesh({
        rootHandle,
        user: validated.user,
        initialEnv: validated.initialEnv,
        initialCwd: validated.initialCwd,
      })

      for (const mount of validated.mounts) {
        switch (mount.type) {
        case 'directory':
          await wesh.vfs.mount({
            path: mount.path,
            handle: mount.handle,
            readOnly: mount.readOnly,
          })
          break
        case 'naidan_sysfs': {
          const reader = await (() => {
            switch (mount.storageType) {
            case 'opfs':
              return createOpfsNaidanSysfsStorageReader({})
            case 'local':
            case 'memory':
              if (validated.naidanSysfsRemoteReader === undefined) {
                throw new Error(`Naidan sysfs remote reader is required for ${mount.storageType} storage`)
              }
              return createRemoteNaidanSysfsStorageReader({
                remoteReader: validated.naidanSysfsRemoteReader,
              })
            default: {
              const _ex: never = mount.storageType
              throw new Error(`Unsupported naidan sysfs storage type: ${String(_ex)}`)
            }
            }
          })()
          wesh.vfs.mountVirtual({
            path: mount.path,
            readOnly: mount.readOnly,
            provider: new NaidanSysfsProvider({
              reader,
              visibility: mount.visibility,
              currentChatId: mount.currentChatId,
              currentChatGroupId: mount.currentChatGroupId,
            }),
          })
          break
        }
        default: {
          const _ex: never = mount
          throw new Error(`Unhandled Wesh worker mount type: ${String(_ex)}`)
        }
        }
      }
    },

    async startExecution(request, onEvent) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized')
      }

      const validated = weshWorkerExecuteRequestSchema.parse(request)
      const executionId = `wesh-exec-${nextExecutionId}`
      nextExecutionId += 1
      const emit = async (event: WeshWorkerRemoteExecutionEvent) => {
        await onEvent?.(event)
      }
      const stdoutCapture = createForwardingHandle({
        stream: 'stdout',
        onEvent: emit,
      })
      const stderrCapture = createForwardingHandle({
        stream: 'stderr',
        onEvent: emit,
      })
      const stdin = createTestReadHandleFromText({ text: '' })
      const completion = (async () => {
        try {
          await emit({ type: 'started' })
          const result = await wesh.execute({
            script: validated.script,
            stdin,
            stdout: stdoutCapture.handle,
            stderr: stderrCapture.handle,
          })
          await emit({ type: 'exit', exitCode: result.exitCode })

          return weshWorkerExecutionSummarySchema.parse({
            exitCode: result.exitCode,
          })
        } catch (error) {
          await emit({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
          throw error
        } finally {
          await Promise.all([
            stdoutCapture.handle.close(),
            stderrCapture.handle.close(),
            stdin.close(),
          ])
        }
      })()

      executions.set(executionId, { completion })
      return weshWorkerStartExecutionResponseSchema.parse({ executionId })
    },

    async awaitExecution({ request }) {
      const validated = weshWorkerAwaitExecutionRequestSchema.parse(request)
      const execution = executions.get(validated.executionId)
      if (!execution) {
        throw new Error(`Unknown wesh execution: ${validated.executionId}`)
      }
      const summary = await execution.completion
      return weshWorkerExecutionSummarySchema.parse(summary)
    },

    async interruptExecution({ request }) {
      if (!wesh) {
        return false
      }
      const validated = weshWorkerInterruptExecutionRequestSchema.parse(request)
      if (!executions.has(validated.executionId)) {
        return false
      }
      return wesh.signalForegroundProcessGroup({ signal: 2 })
    },

    async disposeExecution({ request }) {
      const validated = weshWorkerDisposeExecutionRequestSchema.parse(request)
      executions.delete(validated.executionId)
    },

    async execute({ request }) {
      const { executionId } = await this.startExecution(request)
      try {
        return await this.awaitExecution({ request: { executionId } })
      } finally {
        await this.disposeExecution({ request: { executionId } })
      }
    },

    async interrupt(_args: EmptyArgs) {
      if (!wesh) {
        return false
      }
      return wesh.signalForegroundProcessGroup({ signal: 2 })
    },

    async dispose(_args: EmptyArgs) {
      wesh = undefined
    },
  }
}
