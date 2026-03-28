import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeshTool } from './wesh'
import type { WeshWorkerClient } from '@/services/wesh-worker.types'

describe('createWeshTool', () => {
  let client: WeshWorkerClient
  const encoder = new TextEncoder()

  beforeEach(() => {
    client = {
      startExecution: vi.fn().mockImplementation(async ({ onEvent }) => {
        await onEvent?.({ type: 'started' })
        await onEvent?.({ type: 'stdout', chunk: encoder.encode('hello\n') })
        await onEvent?.({ type: 'exit', exitCode: 0 })
        return {
          executionId: 'exec-1',
        }
      }),
      awaitExecution: vi.fn().mockResolvedValue({
        exitCode: 0,
      }),
      interruptExecution: vi.fn().mockResolvedValue(true),
      cancelExecution: vi.fn().mockResolvedValue(true),
      disposeExecution: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
      }),
      interrupt: vi.fn().mockResolvedValue(true),
      dispose: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('executes shell commands via the worker client', async () => {
    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4096,
      defaultStderrLimit: 4096,
    })

    const result = await tool.execute({
      args: {
        shell_script: 'echo hello',
      },
    })

    expect(client.startExecution).toHaveBeenCalledWith({
      request: {
        script: 'echo hello',
      },
      onEvent: expect.any(Function),
    })
    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 0

STDOUT:
hello

`,
    })
  })

  it('interrupts the worker client when the signal aborts', async () => {
    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4096,
      defaultStderrLimit: 4096,
    })

    const controller = new AbortController()
    vi.mocked(client.startExecution).mockImplementation(async () => {
      controller.abort()
      return { executionId: 'exec-1' }
    })
    vi.mocked(client.awaitExecution).mockResolvedValue({
      exitCode: 130,
    })

    await expect(tool.execute({
      args: { shell_script: 'sleep 1' },
      signal: controller.signal,
    })).rejects.toThrow('Generation aborted')

    expect(client.cancelExecution).toHaveBeenCalledWith({
      request: {
        executionId: 'exec-1',
      },
    })
  })

  it('passes through an explicit timeout override', async () => {
    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4096,
      defaultStderrLimit: 4096,
    })

    await tool.execute({
      args: {
        shell_script: 'echo hello',
        timeout_ms: 1500,
      },
    })

    expect(client.startExecution).toHaveBeenCalledWith({
      request: {
        script: 'echo hello',
      },
      onEvent: expect.any(Function),
    })
  })

  it('returns a timeout error with captured output', async () => {
    vi.mocked(client.startExecution).mockImplementation(async ({ onEvent }) => {
      await onEvent?.({ type: 'started' })
      await onEvent?.({ type: 'stdout', chunk: encoder.encode('before-timeout\n') })
      await onEvent?.({ type: 'stderr', chunk: encoder.encode('partial error\n') })
      await onEvent?.({ type: 'exit', exitCode: 130 })
      return {
        executionId: 'exec-1',
      }
    })
    vi.mocked(client.awaitExecution).mockResolvedValue({
      exitCode: 130,
    })

    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4096,
      defaultStderrLimit: 4096,
    })

    const result = await tool.execute({
      args: {
        shell_script: 'echo before-timeout; echo partial error >&2; sleep 5',
      },
    })

    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 130

STDOUT:
before-timeout


STDERR:
partial error

`,
    })
  })

  it('cancels execution when stdout exceeds the configured limit', async () => {
    vi.mocked(client.startExecution).mockImplementation(async ({ onEvent }) => {
      await onEvent?.({ type: 'started' })
      await onEvent?.({ type: 'stdout', chunk: encoder.encode('abcdef') })
      await onEvent?.({ type: 'exit', exitCode: 130 })
      return {
        executionId: 'exec-1',
      }
    })
    vi.mocked(client.awaitExecution).mockResolvedValue({
      exitCode: 130,
    })

    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4,
      defaultStderrLimit: 4096,
    })

    const result = await tool.execute({
      args: {
        shell_script: 'python -c "print(\\"abcdef\\")"',
      },
    })

    expect(client.cancelExecution).toHaveBeenCalledWith({
      request: {
        executionId: 'exec-1',
      },
    })
    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 130

STDOUT:
abcd
[Output truncated due to size limit]
`,
    })
  })

  it('does not block streaming callbacks while cancellation is in flight', async () => {
    let resolveCancellation: (() => void) | undefined
    let startExecutionReturned = false

    vi.mocked(client.cancelExecution).mockImplementation(() => {
      return new Promise<boolean>(resolve => {
        resolveCancellation = () => resolve(true)
      })
    })
    vi.mocked(client.startExecution).mockImplementation(async ({ onEvent }) => {
      await onEvent?.({ type: 'started' })
      await onEvent?.({ type: 'stdout', chunk: encoder.encode('abcdef') })
      startExecutionReturned = true
      await onEvent?.({ type: 'exit', exitCode: 130 })
      return {
        executionId: 'exec-1',
      }
    })
    vi.mocked(client.awaitExecution).mockResolvedValue({
      exitCode: 130,
    })

    const tool = createWeshTool({
      client,
      mounts: [],
      name: 'shell_execute',
      description: undefined,
      defaultStdoutLimit: 4,
      defaultStderrLimit: 4096,
    })

    const resultPromise = tool.execute({
      args: {
        shell_script: 'python -c "print(\\"abcdef\\")"',
      },
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(startExecutionReturned).toBe(true)
    expect(client.cancelExecution).toHaveBeenCalledWith({
      request: {
        executionId: 'exec-1',
      },
    })

    resolveCancellation?.()

    await expect(resultPromise).resolves.toEqual({
      status: 'success',
      content: `\
Exit Code: 130

STDOUT:
abcd
[Output truncated due to size limit]
`,
    })
  })
})
