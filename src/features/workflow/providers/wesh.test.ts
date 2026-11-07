import { beforeEach, it, expect, vi } from 'vitest';
import type { WeshWorkerClient } from '@/features/wesh/worker/types';
import type { VolumeAccess } from '@/01-models/volume-access';
import { toVolumeId } from '@/01-models/ids';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { openWorkflowShell } from './wesh';

const mocks = vi.hoisted(() => ({ resolve: vi.fn<({ volumeId }: { volumeId: unknown }) => Promise<VolumeAccess>>(), create: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { resolveVolumeAccess: mocks.resolve } }));
vi.mock('@/features/wesh/worker/client', () => ({ createFileProtocolCompatibleWeshWorkerClient: mocks.create }));

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const fs = createWorkflowTestFileSystem();
  const volumeId = toVolumeId({ raw: 'folder' });
  const volume = { id: volumeId, name: 'Explicit folder', type: 'host' as const, createdAt: 1 };
  mocks.resolve.mockResolvedValue({ kind: 'native', volume, handle: fs.root });
  const client: WeshWorkerClient = {
    startExecution: vi.fn(async ({ onEvent }) => {
      await onEvent?.({ event: { type: 'started' } });
      await onEvent?.({ event: { type: 'stdout', chunk: new TextEncoder().encode('hello') } });
      await onEvent?.({ event: { type: 'exit', exitCode: 0 } });
      return { executionId: 'exec' };
    }),
    awaitExecution: vi.fn(async () => ({ exitCode: 0 })),
    interruptExecution: vi.fn(async () => true),
    cancelExecution: vi.fn(async () => true),
    disposeExecution: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ exitCode: 0 })),
    getShellState: vi.fn(async () => ({ cwd: '/', env: {} })),
    listCommands: vi.fn(async () => []),
    listDirectory: vi.fn(async () => []),
    interrupt: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
  };
  mocks.create.mockResolvedValue(client);
  return {
    fs,
    volumeId,
    volume,
    client,
    [Symbol.dispose]() {
      fs[Symbol.dispose]();
    },
  };
}

const args = { shell_script: 'echo hello', stdout_limit: 1024, stderr_limit: 1024, timeout_ms: 8000 };

it.each(['read-only', 'read-write'] as const)('mounts only the chosen folder in %s mode and uses the real bounded tool', async access => {
  using test = fixture();
  const shell = await openWorkflowShell({ volumeId: test.volumeId, access, signal: new AbortController().signal });
  await using resource = {
    async [Symbol.asyncDispose]() {
      await shell.close();
    },
  };
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ rootHandle: 'readonly', mounts: [{ type: 'directory', path: '/workspace', handle: test.fs.root, readOnly: access === 'read-only' }], user: 'user', initialEnv: {}, initialCwd: '/workspace' });
  const result = await shell.execute({ args, signal: new AbortController().signal });
  expect(result.outcome.status).toBe('success');
  expect(result.metadata).toEqual({ exitCode: 0, truncated: false, truncatedStreams: [] });
  expect(test.client.disposeExecution).toHaveBeenCalledExactlyOnceWith({ request: { executionId: 'exec' } });
  await shell.close();
  await shell.close();
  expect(test.client.dispose).toHaveBeenCalledOnce();
  await expect(shell.execute({ args, signal: new AbortController().signal })).rejects.toThrow('closed');
  void resource;
});

it('supports managed folders without materializing or widening their mount', async () => {
  using test = fixture();
  mocks.resolve.mockResolvedValue({ kind: 'managed', volume: test.volume, reference: { volumeId: test.volumeId } });
  const shell = await openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: new AbortController().signal });
  await using resource = {
    async [Symbol.asyncDispose]() {
      await shell.close();
    },
  };
  expect(mocks.create.mock.calls[0]![0].mounts).toEqual([{ type: 'managed_directory', path: '/workspace', reference: { volumeId: test.volumeId }, readOnly: true }]);
  void resource;
});

it.each(['missing', 'incomplete'] as const)('does not create a worker for a %s folder', async kind => {
  using test = fixture();
  mocks.resolve.mockResolvedValue(kind === 'missing' ? { kind, volumeId: test.volumeId } : { kind, volumeId: test.volumeId, handle: test.fs.root });
  await expect(openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: new AbortController().signal })).rejects.toThrow('missing or incomplete');
  expect(mocks.create).not.toHaveBeenCalled();
});

it('disposes a worker obtained after cancellation without starting a command', async () => {
  using test = fixture();
  const controller = new AbortController();
  mocks.create.mockImplementation(async () => {
    controller.abort(new Error('Stop'));
    return test.client;
  });
  await expect(openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: controller.signal })).rejects.toThrow('Stop');
  expect(test.client.dispose).toHaveBeenCalledOnce();
  expect(test.client.startExecution).not.toHaveBeenCalled();
});

it('treats a nonzero exit code as an error while retaining the diagnostic output', async () => {
  using test = fixture();
  vi.mocked(test.client.startExecution).mockImplementation(async ({ onEvent }) => {
    await onEvent?.({ event: { type: 'stderr', chunk: new TextEncoder().encode('missing input') } });
    await onEvent?.({ event: { type: 'exit', exitCode: 7 } });
    return { executionId: 'exec' };
  });
  vi.mocked(test.client.awaitExecution).mockResolvedValue({ exitCode: 7 });
  const shell = await openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: new AbortController().signal });
  await using resource = {
    async [Symbol.asyncDispose]() {
      await shell.close();
    },
  };
  expect(await shell.execute({ args, signal: new AbortController().signal })).toMatchObject({ outcome: { status: 'error', code: 'execution_failed', message: expect.stringContaining('missing input') }, metadata: { exitCode: 7 } });
  void resource;
});

it('never treats truncated output with exit code zero as a complete success', async () => {
  using test = fixture();
  const shell = await openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: new AbortController().signal });
  await using resource = {
    async [Symbol.asyncDispose]() {
      await shell.close();
    },
  };
  const result = await shell.execute({ args: { ...args, stdout_limit: 3 }, signal: new AbortController().signal });
  expect(result).toMatchObject({ outcome: { status: 'error', message: expect.stringContaining('Output truncated') }, metadata: { exitCode: 0, truncated: true, truncatedStreams: ['stdout'] } });
  expect(test.client.cancelExecution).toHaveBeenCalledOnce();
  void resource;
});

it('rejects a successful completion without an exit event rather than guessing zero', async () => {
  using test = fixture();
  vi.mocked(test.client.startExecution).mockResolvedValue({ executionId: 'exec' });
  const shell = await openWorkflowShell({ volumeId: test.volumeId, access: 'read-only', signal: new AbortController().signal });
  await using resource = {
    async [Symbol.asyncDispose]() {
      await shell.close();
    },
  };
  await expect(shell.execute({ args, signal: new AbortController().signal })).rejects.toThrow('exit status');
  void resource;
});

export const TEST_ONLY = {
};
