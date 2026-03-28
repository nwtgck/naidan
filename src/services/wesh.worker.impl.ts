import type { EmptyArgs } from '@/models/types'
import { Wesh } from '@/services/wesh'
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
  type WeshWorkerExecutionEvent,
  type WeshWorkerExecutionSummary,
} from './wesh-worker.types'

function createCaptureHandle({
  limit,
  stream,
  onEvent,
}: {
  limit: number
  stream: 'stdout' | 'stderr'
  onEvent: (event: WeshWorkerExecutionEvent) => Promise<void>
}) {
  let size = 0
  const chunks: Uint8Array[] = []
  let truncated = false
  const streamDecoder = new TextDecoder()

  const handle = createWriteHandleFromStream({
    target: new WritableStream({
      async write(chunk) {
        if (truncated) return
        if (size + chunk.length > limit) {
          const remaining = limit - size
          if (remaining > 0) {
            const acceptedChunk = new Uint8Array(chunk.subarray(0, remaining))
            chunks.push(acceptedChunk)
            const text = streamDecoder.decode(acceptedChunk, { stream: true })
            if (text) {
              await onEvent({ type: stream, text })
            }
            size = limit
          }
          truncated = true
          const truncateEvent = (() => {
            switch (stream) {
            case 'stdout':
              return { type: 'stdout_truncated' } as const
            case 'stderr':
              return { type: 'stderr_truncated' } as const
            default: {
              const _ex: never = stream
              throw new Error(`Unhandled wesh output stream: ${_ex}`)
            }
            }
          })()
          await onEvent(truncateEvent)
          return
        }
        const acceptedChunk = new Uint8Array(chunk)
        chunks.push(acceptedChunk)
        const text = streamDecoder.decode(acceptedChunk, { stream: true })
        if (text) {
          await onEvent({ type: stream, text })
        }
        size += chunk.length
      },
    }),
  })

  return {
    handle,
    async flushStreamDecoder() {
      const text = streamDecoder.decode()
      if (text) {
        await onEvent({ type: stream, text })
      }
    },
    isTruncated() {
      return truncated
    },
    readText() {
      const decoder = new TextDecoder()
      let result = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
      if (truncated) {
        result += '\n[Output truncated due to size limit]'
      }
      return result
    },
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
        await wesh.vfs.mount({
          path: mount.path,
          handle: mount.handle,
          readOnly: mount.readOnly,
        })
      }
    },

    async startExecution(request, onEvent) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized')
      }

      const validated = weshWorkerExecuteRequestSchema.parse(request)
      const executionId = `wesh-exec-${nextExecutionId}`
      nextExecutionId += 1
      const emit = async (event: WeshWorkerExecutionEvent) => {
        await onEvent?.(event)
      }
      const stdoutCapture = createCaptureHandle({
        limit: validated.stdoutLimit,
        stream: 'stdout',
        onEvent: emit,
      })
      const stderrCapture = createCaptureHandle({
        limit: validated.stderrLimit,
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
          await stdoutCapture.flushStreamDecoder()
          await stderrCapture.flushStreamDecoder()
          await emit({ type: 'exit', exitCode: result.exitCode })

          return weshWorkerExecutionSummarySchema.parse({
            exitCode: result.exitCode,
            stdout: stdoutCapture.readText(),
            stderr: stderrCapture.readText(),
            stdoutTruncated: stdoutCapture.isTruncated(),
            stderrTruncated: stderrCapture.isTruncated(),
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
