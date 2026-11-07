// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { WeshWorkerClient } from '@/features/wesh/worker/types';
import { mapRemoteWeshWorkerExecutionEventToClientEvent, mapWeshMountsToWorkerMounts } from '@/features/wesh/worker/types';
import { createWeshWorker } from '@/features/wesh/worker/impl';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { toVolumeId } from '@/01-models/ids';
import type { VolumeAccess } from '@/01-models/volume-access';
import type { WeshMount } from '@/features/wesh/types';
import { openWorkflowShell } from './wesh';

const mocks = vi.hoisted(() => ({ resolve: vi.fn<() => Promise<VolumeAccess>>(), create: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { resolveVolumeAccess: mocks.resolve } }));
vi.mock('@/features/wesh/worker/client', () => ({ createFileProtocolCompatibleWeshWorkerClient: mocks.create }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockImplementation(async ({ rootHandle, mounts, user, initialEnv, initialCwd }: { rootHandle: 'readonly', mounts: WeshMount[], user: string, initialEnv: Record<string, string>, initialCwd: string }) => {
    const worker = createWeshWorker();
    await worker.init({ rootHandle, mounts: mapWeshMountsToWorkerMounts({ mounts }), user, initialEnv, initialCwd });
    // The actual worker implementation runs in-process; only its transport is
    // replaced. Parsing, builtins, filesystems and mount enforcement are real.
    const client: WeshWorkerClient = {
      startExecution: ({ request, onEvent }) => worker.startExecution(request, async event => {
        await onEvent?.({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) });
      }),
      awaitExecution: input => worker.awaitExecution(input),
      interruptExecution: input => worker.interruptExecution(input),
      async cancelExecution(input) {
        await worker.interruptExecution(input);
        await worker.awaitExecution(input);
        return true;
      },
      disposeExecution: input => worker.disposeExecution(input),
      execute: ({ request }) => worker.execute({ request }),
      getShellState: () => worker.getShellState(),
      listCommands: () => worker.listCommands(),
      listDirectory: input => worker.listDirectory(input),
      interrupt: () => worker.interrupt(),
      dispose: () => worker.dispose(),
    };
    return client;
  });
});

async function fixture({ access }: { access: 'read-only' | 'read-write' }) {
  const folder = new MockFileSystemDirectoryHandle({ name: 'Documents' });
  const file = await folder.getFileHandle('note.txt', { create: true });
  const writer = await file.createWritable();
  await writer.write('original');
  await writer.close();
  const volumeId = toVolumeId({ raw: 'folder' });
  mocks.resolve.mockResolvedValue({ kind: 'native', volume: { id: volumeId, name: 'Documents', type: 'host', createdAt: 1 }, handle: folder as unknown as FileSystemDirectoryHandle });
  const controller = new AbortController();
  const shell = await openWorkflowShell({ volumeId, access, signal: controller.signal });
  return {
    folder,
    run({ script }: { script: string }) {
      return shell.execute({ args: { shell_script: script, stdout_limit: 4096, stderr_limit: 4096, timeout_ms: 1000 }, signal: controller.signal });
    },
    async [Symbol.asyncDispose]() {
      controller.abort();
      await shell.close();
    },
  };
}

it('reads the real chosen filesystem at /workspace but rejects writes on a read-only mount', async () => {
  await using shell = await fixture({ access: 'read-only' });
  const read = await shell.run({ script: 'pwd; cat note.txt' });
  expect(read.outcome).toMatchObject({ status: 'success', content: expect.stringContaining('/workspace') });
  expect(read.outcome).toMatchObject({ content: expect.stringContaining('original') });
  expect((await shell.run({ script: 'printf changed > note.txt' })).outcome.status).toBe('error');
  expect(await (await (await shell.folder.getFileHandle('note.txt')).getFile()).text()).toBe('original');
});

it('permits explicit read-write folder operations without making the root writable', async () => {
  await using shell = await fixture({ access: 'read-write' });
  expect((await shell.run({ script: 'printf changed > note.txt' })).outcome.status).toBe('success');
  expect(await (await (await shell.folder.getFileHandle('note.txt')).getFile()).text()).toBe('changed');
  expect((await shell.run({ script: 'printf forbidden > /outside.txt' })).outcome.status).toBe('error');
  expect((await shell.run({ script: 'cat /sys/secret.txt' })).outcome.status).toBe('error');
});

it('does not carry shell variables from one workflow step into the next worker', async () => {
  {
    await using first = await fixture({ access: 'read-only' });
    expect((await first.run({ script: 'export PRIVATE_TOKEN=previous-step; printf "$PRIVATE_TOKEN"' })).outcome).toMatchObject({ status: 'success', content: expect.stringContaining('previous-step') });
  }
  await using second = await fixture({ access: 'read-only' });
  const result = await second.run({ script: 'printf "value=$PRIVATE_TOKEN"' });
  expect(result.outcome).toMatchObject({ status: 'success', content: expect.stringContaining('value=') });
  expect(JSON.stringify(result)).not.toContain('previous-step');
});

export const TEST_ONLY = {
};
