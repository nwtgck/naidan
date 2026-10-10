import { expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { createPendingImageHistory } from './pending-saves';
import { finishImageGenerationSnapshot, snapshotImageGeneration } from './snapshot';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';

function publication() {
  const snapshot = snapshotImageGeneration({
    request: requestFixture(),
    sourceCommit: 'a'.repeat(40),
    createdAt: 1,
    locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }),
  });
  return finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['pixels'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test', uniformOutput: false }, previews: [], elapsedMs: 1 });
}

it('keeps cloned metadata and the original immutable bytes after a view detaches', async () => {
  const store = createPendingImageHistory({ maxEntries: 2, byteLimit: 100 });
  const source = reactive(publication()), save = vi.fn().mockRejectedValueOnce(new Error('full')).mockResolvedValue(undefined);
  const listener = vi.fn(); const stop = store.subscribe({ listener });
  const id = store.retain({ ...source, save });
  const blob = source.files[0]!.blob; source.record.request.parameters.prompt = 'changed';
  await expect(store.retry({ id })).rejects.toThrow('full'); stop();
  const visible = store.list(); visible[0]!.record.request.parameters.prompt = 'mutated view';
  expect(store.list()[0]?.record.request.parameters.prompt).toBe('a small tree');
  await store.retry({ id });
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]![0]).toBe(save.mock.calls[1]![0]);
  expect(save.mock.calls[1]![0].files[0].blob).toBe(blob);
  expect(store.list()).toEqual([]);
});

it('coalesces retries, blocks discard while saving, and rejects a stale retry after discard', async () => {
  const store = createPendingImageHistory({ maxEntries: 2, byteLimit: 100 });
  const gate = Promise.withResolvers<void>(), save = vi.fn(() => gate.promise);
  const id = store.retain({ ...publication(), save });
  const first = store.retry({ id }); expect(store.retry({ id })).toBe(first);
  expect(() => store.discard({ id })).toThrow('finish');
  const rejected = expect(first).rejects.toThrow('full'); gate.reject(new Error('full')); await rejected;
  store.discard({ id }); await expect(store.retry({ id })).rejects.toThrow('discarded');
  expect(save).toHaveBeenCalledOnce();
});

it('limits admission, retains completed pixels, and never evicts an earlier failed image', () => {
  const store = createPendingImageHistory({ maxEntries: 1, byteLimit: 1 });
  store.assertCapacity(); const source = publication();
  const id = store.retain({ ...source, save: vi.fn() });
  expect(() => store.assertCapacity()).toThrow('Save or discard');
  expect(() => store.retain({ ...source, save: vi.fn() })).toThrow('already retained');
  expect(store.list()[0]?.files[0]?.blob).toBe(source.files[0]!.blob);
  store.discard({ id }); store.assertCapacity();
});

it('view listener errors cannot fail retention or completion', async () => {
  const store = createPendingImageHistory({ maxEntries: 1, byteLimit: 100 });
  store.subscribe({
    listener() {
      throw new Error('detached');
    },
  });
  const id = store.retain({ ...publication(), save: async () => {} });
  await store.retry({ id }); expect(store.list()).toEqual([]);
});
