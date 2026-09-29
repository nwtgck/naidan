// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createTransformersJsService } from './index-hosted';
import { withOpfsFileLease } from './runtime/opfs-access';
import { createLockQueue } from './replay-models/support/opfs-lock-test-platform';

afterEach(() => vi.unstubAllGlobals());

it('rechecks the organization after model deletion and preserves a repository created before parent admission', async () => {
  const removed: string[] = [];
  // Directory-only native platform. The real service chooses deletion scopes
  // and re-resolves handles; no model body or runtime is needed for this race.
  function directory({ path }: { path: string }): FileSystemDirectoryHandle {
    const children = new Map<string, FileSystemDirectoryHandle>();
    return {
      kind: 'directory', name: path.split('/').at(-1) ?? '',
      async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
        let child = children.get(name);
        if (child === undefined && options?.create) {
          child = directory({ path: `${path}/${name}` });
          children.set(name, child);
        }
        if (child === undefined) throw new DOMException('Synthetic missing directory', 'NotFoundError');
        return child;
      },
      async removeEntry(name: string) {
        if (!children.delete(name)) throw new DOMException('Synthetic missing directory', 'NotFoundError');
        removed.push(`${path}/${name}`);
      },
      async *entries() {
        yield* children;
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  const root = directory({ path: '' });
  const models = await root.getDirectoryHandle('models', { create: true });
  const hf = await models.getDirectoryHandle('huggingface.co', { create: true });
  const org = await hf.getDirectoryHandle('fixture', { create: true });
  await org.getDirectoryHandle('removed-model', { create: true });
  const q = createLockQueue();
  const parentRequested = Promise.withResolvers<void>();
  const releaseParent = Promise.withResolvers<void>();
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    locks: { request: async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
      if (name === 'naidan:transformers-js:opfs:models' && options.mode === 'exclusive') {
        parentRequested.resolve();
        await releaseParent.promise;
      }
      return await q.locks.request(name, options, callback);
    } },
  });
  const factory = vi.fn(() => {
    throw new Error('Storage deletion must not create a model Worker');
  });
  const owner = createTransformersJsService({ createWorkerClient: factory });
  const deleting = owner.service.deleteModel({ modelId: 'hf.co/fixture/removed-model' });
  try {
    await parentRequested.promise;
    expect(removed).toEqual(['/models/huggingface.co/fixture/removed-model']);
    expect(q.held.size).toBe(0);
    await withOpfsFileLease({ path: 'models/huggingface.co/fixture/new-model/resolve/main/config.json', mode: 'exclusive', availability: 'wait', signal: undefined, run: async () => {
      await org.getDirectoryHandle('new-model', { create: true });
    } });
    releaseParent.resolve();
    await deleting;
    const retained = await hf.getDirectoryHandle('fixture', { create: false });
    await expect(retained.getDirectoryHandle('new-model', { create: false })).resolves.toBeDefined();
    expect(removed).toEqual(['/models/huggingface.co/fixture/removed-model']);
    expect(factory).not.toHaveBeenCalled();
    expect(q.held.size).toBe(0);
    expect(q.queued).toEqual([]);
  } finally {
    releaseParent.resolve();
    await deleting;
    await owner.dispose();
  }
});
