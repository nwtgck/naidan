import { Wesh } from '@/services/wesh'
import { ReadonlyDirectoryHandle } from '@/services/wesh/readonly-directory-handle'
import { createWeshReadFileHandleFromText } from '@/services/wesh/utils/test-stream'
import { createWeshWriteFileHandle } from '@/services/wesh/utils/stream'
import {
  weshWorkerExecuteRequestSchema,
  weshWorkerExecuteResponseSchema,
  weshWorkerInitRequestSchema,
  type IWeshWorker,
} from './wesh-worker.types'

function createCaptureHandle({ limit }: {
  limit: number
}) {
  let size = 0
  const chunks: Uint8Array[] = []
  let truncated = false

  const handle = createWeshWriteFileHandle({
    target: new WritableStream({
      write(chunk) {
        if (truncated) return
        if (size + chunk.length > limit) {
          const remaining = limit - size
          if (remaining > 0) {
            chunks.push(new Uint8Array(chunk.subarray(0, remaining)))
            size = limit
          }
          truncated = true
          return
        }
        chunks.push(new Uint8Array(chunk))
        size += chunk.length
      },
    }),
  })

  return {
    handle,
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

export function createWeshWorker(_args: { noop?: never }): IWeshWorker {
  let wesh: Wesh | undefined

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

    async execute({ request }) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized')
      }

      const validated = weshWorkerExecuteRequestSchema.parse(request)
      const stdoutCapture = createCaptureHandle({ limit: validated.stdoutLimit })
      const stderrCapture = createCaptureHandle({ limit: validated.stderrLimit })
      const stdin = createWeshReadFileHandleFromText({ text: '' })

      try {
        const result = await wesh.execute({
          script: validated.script,
          stdin,
          stdout: stdoutCapture.handle,
          stderr: stderrCapture.handle,
        })

        return weshWorkerExecuteResponseSchema.parse({
          exitCode: result.exitCode,
          stdout: stdoutCapture.readText(),
          stderr: stderrCapture.readText(),
        })
      } finally {
        await Promise.all([
          stdoutCapture.handle.close(),
          stderrCapture.handle.close(),
          stdin.close(),
        ])
      }
    },

    async interrupt(_args: { noop?: never }) {
      if (!wesh) {
        return false
      }
      return wesh.signalForegroundProcessGroup({ signal: 2 })
    },

    async dispose(_args: { noop?: never }) {
      wesh = undefined
    },
  }
}
