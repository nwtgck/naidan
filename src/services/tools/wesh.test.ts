import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeshTool } from './wesh'
import type { WeshWorkerClient } from '@/services/wesh-worker.types'

describe('createWeshTool', () => {
  let client: WeshWorkerClient

  beforeEach(() => {
    client = {
      startExecution: vi.fn().mockResolvedValue({
        executionId: 'exec-1',
      }),
      awaitExecution: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      interruptExecution: vi.fn().mockResolvedValue(true),
      disposeExecution: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
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
        stdoutLimit: 4096,
        stderrLimit: 4096,
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
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })

    await tool.execute({
      args: { shell_script: 'sleep 1' },
      signal: controller.signal,
    })

    expect(client.interrupt).toHaveBeenCalledWith({})
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
        timeoutMs: 1500,
      },
    })

    expect(client.startExecution).toHaveBeenCalledWith({
      request: {
        script: 'echo hello',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
      onEvent: expect.any(Function),
    })
  })

  it('returns a timeout error with captured output', async () => {
    vi.mocked(client.startExecution).mockResolvedValue({
      executionId: 'exec-1',
    })
    vi.mocked(client.awaitExecution).mockResolvedValue({
      exitCode: 130,
      stdout: 'before-timeout\n',
      stderr: 'partial error\n',
      stdoutTruncated: false,
      stderrTruncated: false,
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
})
