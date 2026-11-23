import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWeshTool } from '.';
import { createWeshWorkerClient } from '@/features/wesh/worker/client-runtime';
import type { IWeshWorker, WeshWorkerClient, WeshWorkerExecutionEvent, WeshWorkerExecutionOutcome } from '@/features/wesh/worker/types';
import { createEndpoint, releaseProxy } from 'comlink';
import type { WorkerRemote } from '@/utils/worker-transport';

const encoder = new TextEncoder();

describe('createWeshTool', () => {
  let client: WeshWorkerClient;
  let cancel: ReturnType<typeof vi.fn<() => void>>;

  function setEvents({ events, exitCode }: { events: WeshWorkerExecutionEvent[], exitCode: number }) {
    vi.mocked(client.startExecution).mockImplementation(({ onEvent }) => ({
      completion: Promise.resolve().then(async () => {
        for (const event of events) {
          await onEvent?.({ event });
        }
        return { status: 'exited', exitCode } as const;
      }),
      cancel,
    }));
  }

  beforeEach(() => {
    cancel = vi.fn<() => void>();
    client = {
      startExecution: vi.fn(),
      getShellState: vi.fn().mockResolvedValue({ cwd: '/', env: {} }),
      listCommands: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue([]),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    setEvents({
      events: [
        { type: 'started' },
        { type: 'stdout', chunk: encoder.encode('hello\n') },
        { type: 'exit', exitCode: 0 },
      ],
      exitCode: 0,
    });
  });

  function createTool({ stdoutLimit, stderrLimit, onOutputLimit }: {
    stdoutLimit: number, stderrLimit: number, onOutputLimit: Parameters<typeof createWeshTool>[0]['onOutputLimit'],
  }) {
    return createWeshTool({ client, mounts: [], name: 'shell_execute', description: undefined, defaultStdoutLimit: stdoutLimit, defaultStderrLimit: stderrLimit, onOutputLimit });
  }

  it('executes shell commands via the worker client', async () => {
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const result = await tool.execute({ args: { shell_script: 'echo hello' } });

    expect(client.startExecution).toHaveBeenCalledWith({
      request: { script: 'echo hello' },
      onEvent: expect.any(Function),
    });
    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 0

STDOUT:
hello

`,
    });
  });

  it('interrupts the command when the signal aborts during start', async () => {
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const controller = new AbortController();
    vi.mocked(client.startExecution).mockImplementation(() => {
      controller.abort();
      return { completion: Promise.resolve({ status: 'exited', exitCode: 130 }), cancel };
    });

    await expect(tool.execute({ args: { shell_script: 'sleep 1' }, signal: controller.signal })).rejects.toThrow('Generation aborted');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts an explicit timeout override', async () => {
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    await tool.execute({ args: { shell_script: 'echo hello', timeout_ms: 1500 } });
    expect(client.startExecution).toHaveBeenCalledWith({
      request: { script: 'echo hello' },
      onEvent: expect.any(Function),
    });
  });

  it('preserves the exit code and captured stdout and stderr', async () => {
    setEvents({
      events: [
        { type: 'started' },
        { type: 'stdout', chunk: encoder.encode('before-timeout\n') },
        { type: 'stderr', chunk: encoder.encode('partial error\n') },
        { type: 'exit', exitCode: 130 },
      ],
      exitCode: 130,
    });
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const result = await tool.execute({ args: { shell_script: 'echo before-timeout; echo partial error >&2; sleep 5' } });
    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 130

STDOUT:
before-timeout


STDERR:
partial error

`,
    });
  });

  it('keeps forwarding the truncated prefix and exit event while cancellation is pending', async () => {
    setEvents({
      events: [
        { type: 'started' },
        { type: 'stdout', chunk: encoder.encode('abcdef') },
        { type: 'exit', exitCode: 130 },
      ],
      exitCode: 130,
    });
    const onEvent = vi.fn();
    const tool = createTool({ stdoutLimit: 4, stderrLimit: 4096, onOutputLimit: undefined });
    const result = await tool.execute({ args: { shell_script: 'printf abcdef' }, onEvent });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls).toEqual([
      [{ event: { type: 'started' } }],
      [{ event: { type: 'output', stream: 'stdout', text: 'abcd' } }],
      [{ event: { type: 'exit', exitCode: 130 } }],
    ]);
    expect(result).toEqual({
      status: 'success',
      content: `\
Exit Code: 130

STDOUT:
abcd
[Output truncated due to size limit]
`,
    });
  });

  it('clears the timeout after ordinary completion', async () => {
    vi.useFakeTimers();
    using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const result = await tool.execute({ args: { shell_script: 'echo hello', timeout_ms: 600000 } });
    expect(result.status).toBe('success');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the client-owned completion after generation abort and preserves AbortError', async () => {
    const gate = Promise.withResolvers<WeshWorkerExecutionOutcome>();
    const controller = new AbortController();
    vi.mocked(client.startExecution).mockReturnValue({ completion: gate.promise, cancel });
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const settled = vi.fn();
    const execution = tool.execute({ args: { shell_script: 'sleep 60' }, signal: controller.signal });
    void execution.then(settled, settled);
    controller.abort();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve({ status: 'exited', exitCode: 130 });
    await expect(execution).rejects.toMatchObject({ name: 'AbortError', message: 'Generation aborted' });
  });

  it('reports each truncated stream once without requiring callers to parse output text', async () => {
    const onOutputLimit = vi.fn();
    setEvents({
      events: [
        ...(['stdout', 'stderr', 'stdout', 'stderr'] as const).map(type => ({ type, chunk: encoder.encode('abcdef') })),
        { type: 'exit', exitCode: 0 },
      ],
      exitCode: 0,
    });
    const tool = createTool({ stdoutLimit: 4, stderrLimit: 4, onOutputLimit });
    await tool.execute({ args: { shell_script: 'printf abcdef; printf abcdef >&2' } });
    expect(onOutputLimit.mock.calls).toEqual([[{ stream: 'stdout' }], [{ stream: 'stderr' }]]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps timed-out executions owned until the client completes cooperative cancellation', async () => {
    vi.useFakeTimers();
    using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
    const gate = Promise.withResolvers<WeshWorkerExecutionOutcome>();
    vi.mocked(client.startExecution).mockImplementation(({ onEvent }) => ({
      completion: Promise.resolve().then(async () => {
        await onEvent?.({ event: { type: 'stdout', chunk: encoder.encode('partial') } });
        return gate.promise;
      }),
      cancel,
    }));
    const tool = createTool({ stdoutLimit: 4096, stderrLimit: 4096, onOutputLimit: undefined });
    const settled = vi.fn();
    const execution = tool.execute({ args: { shell_script: 'sleep 60', timeout_ms: 25 } });
    void execution.then(settled);
    await vi.advanceTimersByTimeAsync(26);
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    gate.resolve({ status: 'exited', exitCode: 130 });
    await expect(execution).resolves.toEqual({
      status: 'error',
      code: 'timeout',
      message: `\
Shell execution timed out after 25ms.

Exit Code: 130

STDOUT:
partial
`,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout during command', 'timeout during initialization', 'abort during command'] as const)('settles after %s without an interrupt or execution RPC response', async mode => {
    vi.useFakeTimers();
    using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
    const terminate = vi.fn();
    const remote = {
      init: vi.fn<IWeshWorker['init']>(() => mode === 'timeout during initialization' ? new Promise<void>(() => {}) : Promise.resolve()),
      execute: vi.fn<IWeshWorker['execute']>(() => new Promise<{ exitCode: number }>(() => {})),
      interrupt: vi.fn<IWeshWorker['interrupt']>(() => new Promise<boolean>(() => {})),
      getShellState: vi.fn(),
      listCommands: vi.fn(),
      preloadNextCommand: vi.fn(),
      listDirectory: vi.fn(),
      dispose: vi.fn(),
      [createEndpoint]: vi.fn(),
      [releaseProxy]: vi.fn(),
    };
    const actualClient = createWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
      createSession: async () => ({
        worker: Object.assign(new EventTarget(), { terminate }) as unknown as Worker,
        remote: remote as unknown as WorkerRemote<IWeshWorker>,
      }),
    });
    const tool = createWeshTool({ client: actualClient, mounts: [], name: 'shell_execute', description: undefined, defaultStdoutLimit: 4096, defaultStderrLimit: 4096 });
    const controller = new AbortController();
    const result = tool.execute({ args: { shell_script: 'sleep 60', timeout_ms: 25 }, signal: controller.signal });
    // Attach a rejection handler before advancing the clock.
    const settled = result.then(value => value, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === 'abort during command') {
      controller.abort();
      await vi.advanceTimersByTimeAsync(150);
      expect(await settled).toMatchObject({ name: 'AbortError', message: 'Generation aborted' });
    } else {
      await vi.advanceTimersByTimeAsync(175);
      await expect(result).resolves.toEqual({
        status: 'error',
        code: 'timeout',
        message: `\
Shell execution timed out after 25ms.

Shell worker terminated.
`,
      });
    }
    expect(remote.init).toHaveBeenCalledOnce();
    expect(remote.interrupt).toHaveBeenCalledTimes(mode === 'timeout during initialization' ? 0 : 1);
    expect(terminate).toHaveBeenCalledOnce();
    await tool.dispose?.();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
