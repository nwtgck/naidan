// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createLazyVolumeTestHarness } from '@/00-storage/service/lazy-volumes.test-support';
import { createFileExplorerWorker } from '@/features/file-explorer/worker/impl';
import { createWeshWorker } from './impl';
import type { ManagedVolumeRemoteAccess } from './managed-volume-access';
import type { IWeshWorker, WeshWorkerMount } from './types';
import { hasWeshFileSystemHandles, createWeshWorkerInitRequest } from './init-request';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { toVolumeId } from '@/01-models/ids';

async function execute({ worker, script }: { worker: WorkerServerApi<IWeshWorker>, script: string }) {
  const stdout: string[] = [];
  const { executionId } = await worker.startExecution({ script }, event => {
    switch (event.type) {
    case 'stdout':
      stdout.push(new TextDecoder().decode(event.buffer));
      break;
    case 'started':
    case 'stderr':
    case 'exit':
    case 'error':
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled execution event: ${String(exhaustive)}`);
    }
    }
  });
  try {
    const response = await worker.awaitExecution({ request: { executionId } });
    return { ...response, stdout: stdout.join('') };
  } finally {
    await worker.disposeExecution({ request: { executionId } });
  }
}

describe('managed directory worker integration', () => {
  it('reads before copying and shares a later write with an existing explorer session', async () => {
    const blocked = Promise.withResolvers<void>();
    let copyStarted = false;
    const harness = createLazyVolumeTestHarness({
      beforeOpen: undefined,
      beforeWrite: async ({ name }) => {
        if (name === 'a.txt') {
          copyStarted = true;
          await blocked.promise;
        }
      },
    });
    const volume = harness.manager.register({ name: 'Documents', files: [{ relativePath: 'a.txt', file: new File(['original'], 'a.txt') }], signal: undefined });
    const connection = await harness.connect({ volumeId: volume.id, readOnly: false });
    const remoteAccess: ManagedVolumeRemoteAccess = {
      async getRoot() {
        return connection.root;
      },
      request: ({ request }) => connection.access.request({ request }),
    };
    const mounts: WeshWorkerMount[] = [{ type: 'managed_directory', path: '/work', reference: { volumeId: volume.id }, readOnly: false }];
    const worker = createWeshWorker();
    const explorer = createFileExplorerWorker();
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        blocked.resolve();
        await worker.dispose();
        await harness.dispose();
      },
    };
    void cleanup;
    await worker.init({ rootHandle: 'readonly', mounts, user: 'user', initialEnv: {}, initialCwd: '/work' }, undefined, remoteAccess);
    const { sessionId } = await explorer.prepareSession({ request: { root: { kind: 'wesh-mounts', rootName: 'Documents', mounts } } }, undefined, remoteAccess);
    await using explorerCleanup = {
      async [Symbol.asyncDispose]() {
        await explorer.disposeSession({ request: { sessionId } });
      },
    };
    void explorerCleanup;
    await vi.waitFor(() => expect(copyStarted).toBe(true));

    expect(await execute({ worker, script: 'cat /work/a.txt' })).toEqual({ exitCode: 0, stdout: 'original' });
    const pendingWrite = execute({ worker, script: 'printf edited > /work/a.txt' });
    expect((await explorer.readDirectory({ request: { sessionId, path: '/work' } })).entries.map(entry => entry.name)).toContain('a.txt');
    expect((await explorer.prepareFileDownload({ request: { sessionId, path: '/work/a.txt' } })).kind).toBe('file');
    const original = await explorer.readFile({ request: { sessionId, path: '/work/a.txt' } });
    expect(await original.blob.text()).toBe('original');
    expect(harness.publish).not.toHaveBeenCalled();

    blocked.resolve();
    expect((await pendingWrite).exitCode).toBe(0);
    const edited = await explorer.readFile({ request: { sessionId, path: '/work/a.txt' } });
    expect(await edited.blob.text()).toBe('edited');
    await harness.manager.retry({ volumeId: volume.id });
    expect(harness.publish).toHaveBeenCalled();
    expect(await execute({ worker, script: 'cat /work/a.txt' })).toEqual({ exitCode: 0, stdout: 'edited' });
  }, 30_000);

  it('preserves read-only mounts while a volume is managed', async () => {
    const harness = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = harness.manager.register({ name: 'Read only', files: [{ relativePath: 'a.txt', file: new File(['original'], 'a.txt') }], signal: undefined });
    const connection = await harness.connect({ volumeId: volume.id, readOnly: true });
    const worker = createWeshWorker();
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.dispose();
        await harness.dispose();
      },
    };
    void cleanup;
    await worker.init({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/reference', reference: { volumeId: volume.id }, readOnly: true }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    }, undefined, {
      async getRoot() {
        return connection.root;
      },
      request: ({ request }) => connection.access.request({ request }),
    });
    expect((await execute({ worker, script: 'printf changed > /reference/a.txt' })).exitCode).not.toBe(0);
    expect(await execute({ worker, script: 'cat /reference/a.txt' })).toEqual({ exitCode: 0, stdout: 'original' });
  });

  it('keeps managed descriptors outside native handle clone and locator transport', async () => {
    const harness = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = harness.manager.register({ name: 'Documents', files: [], signal: undefined });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await harness.dispose();
      },
    };
    void cleanup;
    const mounts = [{ type: 'managed_directory' as const, path: '/work', reference: { volumeId: volume.id }, readOnly: false }];
    expect(hasWeshFileSystemHandles({ rootHandle: 'readonly', mounts })).toBe(false);
    const request = await createWeshWorkerInitRequest({ rootHandle: 'readonly', mounts, user: 'user', initialEnv: {}, initialCwd: undefined, transport: 'direct' });
    expect(structuredClone(request)).toEqual(request);
    expect(request.mounts).toEqual(mounts);
  });

  it('initializes only the final mount at a normalized path without opening the overridden source', async () => {
    const native = new MockFileSystemDirectoryHandle({ name: 'visible' });
    const file = await native.getFileHandle('a.txt', { create: true });
    const writer = await file.createWritable();
    await writer.write('visible native content');
    await writer.close();
    const worker = createWeshWorker();
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.dispose();
      },
    };
    await worker.init({
      rootHandle: 'readonly',
      mounts: [
        { type: 'managed_directory', path: '/work/../documents/', reference: { volumeId: toVolumeId({ raw: 'missing-overridden' }) }, readOnly: false },
        { type: 'directory', path: '/documents', handle: native as unknown as FileSystemDirectoryHandle, readOnly: true },
      ],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });
    expect(await execute({ worker, script: 'cat /documents/a.txt' })).toEqual({ exitCode: 0, stdout: 'visible native content' });
  });
});
