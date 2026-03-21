import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeshTool } from './wesh'
import type { WeshWorkerClient } from '@/services/wesh-worker.types'

describe('createWeshTool', () => {
  let client: WeshWorkerClient

  beforeEach(() => {
    client = {
      execute: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
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

    expect(client.execute).toHaveBeenCalledWith({
      request: {
        script: 'echo hello',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
    })
    expect(result).toEqual({
      status: 'success',
      content: 'Exit Code: 0\n\nSTDOUT:\nhello\n\n',
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
    vi.mocked(client.execute).mockImplementation(async () => {
      controller.abort()
      return {
        exitCode: 130,
        stdout: '',
        stderr: '',
      }
    })

    await tool.execute({
      args: { shell_script: 'sleep 1' },
      signal: controller.signal,
    })

    expect(client.interrupt).toHaveBeenCalledTimes(1)
  })
})
