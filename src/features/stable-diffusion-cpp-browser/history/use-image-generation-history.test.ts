import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationHistoryPage, ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ChangeListener } from '@/00-storage/service/synchronizer';
import type { StorageType } from '@/01-models/types';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import { createImageForm } from '@/features/stable-diffusion-cpp-browser/form';

const mocks = vi.hoisted(() => ({ query: vi.fn(), dispose: vi.fn(), load: vi.fn(), remove: vi.fn(), removeImage: vi.fn(), getFile: vi.fn(), subscribe: vi.fn() }));
vi.mock('./worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, dispose: mocks.dispose }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadImageGeneration: mocks.load, deleteImageGeneration: mocks.remove, deleteBinaryObject: mocks.removeImage, getFile: mocks.getFile, subscribeToChanges: mocks.subscribe } }));
import { useImageGenerationHistory } from './use-image-generation-history';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Pending promise not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Pending promise not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes; reject = no;
  });
  return { promise, resolve, reject };
}
function page({ label }: { label: string }): ImageGenerationHistoryPage {
  return { total: 1, warnings: [], warningCount: 0, items: [{ id: toImageGenerationId({ raw: label }), prompt: label, modelName: 'model', createdAt: 1, binaryObjectId: toBinaryObjectId({ raw: 'image-id' }), width: 256, height: 256, previewCount: 0 }] };
}
function record({ label }: { label: string }): ImageGenerationRecord {
  const form = createImageForm({ profile: 'webgpu-wasm64-jspi' });
  return {
    id: toImageGenerationId({ raw: label }), createdAt: 1000,
    request: {
      parameters: { ...form.parameters.value, prompt: label }, models: [], loras: [],
      imageInputs: { initImage: undefined, strength: 0.75, referenceImages: [] },
      preview: { ...form.preview.value },
      runtime: { sourceCommit: 'a'.repeat(40), profile: 'webgpu-wasm64-jspi', weightResidency: 'auto', gpuBudgetMiB: undefined },
    },
    result: { binaryObjectId: toBinaryObjectId({ raw: `${label}-image` }), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 },
    previews: [],
  };
}
let storageType: StorageType;
let listener: ChangeListener | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); storageType = 'opfs';
  mocks.subscribe.mockImplementation(({ listener: next }: { listener: ChangeListener }) => {
    listener = next; return () => {
      listener = undefined;
    };
  });
  mocks.dispose.mockResolvedValue(undefined);
  mocks.removeImage.mockReset().mockResolvedValue(undefined);
});

describe('explicit final image deletion', () => {
  it('deletes only the selected final binary and invalidates that ID without changing records or reloading the list', async () => {
    const chosen = record({ label: 'chosen' });
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    mocks.load.mockResolvedValue(chosen);
    await view.select({ id: chosen.id });
    const snapshot = structuredClone(chosen);
    const items = view.items.value;
    await view.removeImage({ id: chosen.id, binaryObjectId: chosen.result.binaryObjectId });
    expect(mocks.removeImage).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: chosen.result.binaryObjectId });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(view.selected.value).toBe(chosen);
    expect(chosen).toEqual(snapshot);
    expect(view.items.value).toBe(items);
    expect(view.imageInvalidation.value).toEqual({ binaryObjectId: chosen.result.binaryObjectId, revision: 1 });
    await listener?.({ event: { type: 'binary_objects', timestamp: 1 } });
    expect(view.imageInvalidation.value?.revision).toBe(1);
    await view.dispose();
  });

  it('rejects changed targets and unavailable storage before deletion, and propagates failure without invalidation', async () => {
    const chosen = record({ label: 'chosen' });
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    mocks.load.mockResolvedValue(chosen); await view.select({ id: chosen.id });
    await expect(view.removeImage({ id: toImageGenerationId({ raw: 'other' }), binaryObjectId: chosen.result.binaryObjectId })).rejects.toThrow('changed');
    await expect(view.removeImage({ id: chosen.id, binaryObjectId: toBinaryObjectId({ raw: 'input-image' }) })).rejects.toThrow('changed');
    storageType = 'memory';
    await expect(view.removeImage({ id: chosen.id, binaryObjectId: chosen.result.binaryObjectId })).rejects.toThrow('OPFS');
    expect(mocks.removeImage).not.toHaveBeenCalled();
    storageType = 'opfs'; mocks.removeImage.mockRejectedValue(new Error('Cannot remove file'));
    await expect(view.removeImage({ id: chosen.id, binaryObjectId: chosen.result.binaryObjectId })).rejects.toThrow('Cannot remove file');
    expect(view.imageInvalidation.value).toBeUndefined();
    expect(view.selected.value).toBe(chosen);
    await view.dispose();
  });

  it('keeps an in-flight deletion bound to its snapshot and ignores stale completion after a storage migration', async () => {
    const chosen = record({ label: 'chosen' }), other = record({ label: 'other' });
    const pending = deferred<void>();
    mocks.removeImage.mockReturnValue(pending.promise);
    mocks.load.mockResolvedValueOnce(chosen).mockResolvedValueOnce(other);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: chosen.id });
    const deleting = view.removeImage({ id: chosen.id, binaryObjectId: chosen.result.binaryObjectId });
    await view.select({ id: other.id });
    storageType = 'memory'; await listener?.({ event: { type: 'migration', timestamp: 1 } });
    storageType = 'opfs'; await listener?.({ event: { type: 'migration', timestamp: 2 } });
    pending.resolve(); await deleting;
    expect(mocks.removeImage).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: chosen.result.binaryObjectId });
    expect(view.imageInvalidation.value).toBeUndefined();
    await view.dispose();
  });
});

describe('image history selection ownership', () => {
  it('retains the displayed snapshot during a switch and replaces it only when the next record is ready', async () => {
    const first = record({ label: 'first' }), next = record({ label: 'next' });
    const pending = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const selecting = view.select({ id: next.id });
    expect(view.selected.value).toBe(first);
    expect(view.detailLoading.value).toBe(true);
    expect(view.select({ id: next.id })).toBe(selecting);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    pending.resolve(next);
    await selecting;
    expect(view.selected.value).toBe(next);
    expect(view.detailLoading.value).toBe(false);
    await view.select({ id: next.id });
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(view.selected.value).toBe(next);
    await view.dispose();
  });

  it('keeps a failed replacement local and permits an explicit retry', async () => {
    const first = record({ label: 'first' }), next = record({ label: 'next' });
    mocks.load.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('Cannot read selected image')).mockResolvedValueOnce(next);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    await view.select({ id: next.id });
    expect(view.selected.value).toBe(first);
    expect(view.detailLoading.value).toBe(false);
    expect(view.detailError.value).toBe('Cannot read selected image');
    await view.select({ id: next.id });
    expect(view.selected.value).toBe(next);
    expect(view.detailError.value).toBe('');
    await view.dispose();
  });

  it('ignores an older replacement when a newer selection completes first', async () => {
    const first = record({ label: 'first' }), old = record({ label: 'old' }), latest = record({ label: 'latest' });
    const pending = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(latest);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const selecting = view.select({ id: old.id });
    await view.select({ id: latest.id });
    pending.resolve(old);
    await selecting;
    expect(view.selected.value).toBe(latest);
    expect(view.detailLoading.value).toBe(false);
    await view.dispose();
  });

  it.each(['reselect', 'close', 'storage'] as const)('ignores an in-flight replacement after %s', async action => {
    const first = record({ label: 'first' }), next = record({ label: 'next' });
    const pending = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const selecting = view.select({ id: next.id });
    switch (action) {
    case 'reselect': await view.select({ id: first.id }); break;
    case 'close': view.clearSelection(); break;
    case 'storage':
      storageType = 'memory';
      await listener?.({ event: { type: 'migration', timestamp: 1 } });
      break;
    default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
    }
    pending.resolve(next);
    await selecting;
    expect(view.selected.value).toBe(action === 'reselect' ? first : undefined);
    expect(view.detailLoading.value).toBe(false);
    expect(view.detailError.value).toBe('');
    expect(mocks.load).toHaveBeenCalledTimes(2);
    await view.dispose();
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('image history query ownership', () => {
  it('keeps the displayed results and ignores a previous response during the next debounce', async () => {
    const initial = page({ label: 'initial' });
    const old = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(initial).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page({ label: 'new' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    const loading = view.reload();
    view.setQuery({ text: 'new' });
    expect(view.items.value).toBe(initial.items);
    expect(view.loading.value).toBe(true);
    old.resolve(page({ label: 'old' })); await loading;
    expect(view.items.value).toBe(initial.items);
    expect(view.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.items.value[0]?.prompt).toBe('new');
    expect(view.loading.value).toBe(false);
    await view.dispose();
  });
  it('invalidates pending reads and clears visible state when storage is replaced', async () => {
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockReturnValue(pending.promise);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    const loading = view.reload();
    storageType = 'memory'; await listener?.({ event: { type: 'migration', timestamp: 1 } });
    pending.resolve(page({ label: 'stale' })); await loading;
    expect(view.available.value).toBe(false); expect(view.items.value).toEqual([]); expect(view.loading.value).toBe(false);
    await view.reload(); expect(mocks.query).toHaveBeenCalledTimes(1);
    await view.dispose();
  });
  it('reports a query read failure instead of a successful empty result', async () => {
    mocks.query.mockRejectedValueOnce(new Error('Corrupt shard index'));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload(); expect(view.error.value).toBe('Corrupt shard index');
    mocks.query.mockResolvedValueOnce(page({ label: 'retry' }));
    await view.reload(); expect(view.error.value).toBe(''); expect(view.items.value[0]?.prompt).toBe('retry');
    await view.dispose();
  });
  it('retains warnings with their displayed results until a new query replaces both', async () => {
    mocks.query.mockResolvedValueOnce({ ...page({ label: 'readable' }), warnings: [{ path: 'ab/incomplete-aB.json', message: 'Empty JSON' }], warningCount: 1 }).mockResolvedValueOnce(page({ label: 'new match' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    expect(view.items.value[0]?.prompt).toBe('readable'); expect(view.error.value).toBe('');
    expect(view.warningCount.value).toBe(1); expect(view.warnings.value[0]?.path).toBe('ab/incomplete-aB.json');
    view.setQuery({ text: 'new query' });
    expect(view.items.value[0]?.prompt).toBe('readable');
    expect(view.warningCount.value).toBe(1); expect(view.warnings.value[0]?.path).toBe('ab/incomplete-aB.json');
    expect(view.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.items.value[0]?.prompt).toBe('new match');
    expect(view.warningCount.value).toBe(0); expect(view.warnings.value).toEqual([]);
    await view.dispose();
  });
  it('preserves the selected history when deletion fails', async () => {
    mocks.remove.mockRejectedValue(new Error('Cannot delete record'));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await expect(view.remove({ id: toImageGenerationId({ raw: 'record-id' }) })).rejects.toThrow('Cannot delete');
    expect(mocks.query).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('does not issue a delayed query after disposal', async () => {
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    view.setQuery({ text: 'cat' }); await view.dispose(); await vi.advanceTimersByTimeAsync(500);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('debounces rapid typing and clearing without clearing the current images or selected detail', async () => {
    const initial = page({ label: 'initial' }), selected = record({ label: 'selected' });
    mocks.query.mockResolvedValueOnce(initial).mockResolvedValueOnce(page({ label: 'all images' }));
    mocks.load.mockResolvedValueOnce(selected);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    await view.select({ id: selected.id });
    for (const text of ['g', 'ga', 'garden', '']) {
      view.setQuery({ text });
      expect(view.loading.value).toBe(true);
      expect(view.items.value).toBe(initial.items);
      expect(view.selected.value).toBe(selected);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: '', offset: 0, limit: 40 } });
    expect(view.items.value[0]?.prompt).toBe('all images');
    expect(view.selected.value).toBe(selected);
    expect(view.loading.value).toBe(false);
    await view.dispose();
  });
  it('blocks pagination during a replacement and after failure, then retries the query from the beginning', async () => {
    const initial = { ...page({ label: 'initial' }), total: 5 };
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page({ label: 'retry' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    view.setQuery({ text: 'garden' });
    await view.loadMore();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    await view.loadMore();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    pending.reject(new Error('Cannot read index'));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.items.value).toBe(initial.items);
    expect(view.total.value).toBe(5);
    expect(view.error.value).toBe('Cannot read index');
    expect(view.loading.value).toBe(false);
    await view.loadMore();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await view.reload();
    expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: 'garden', offset: 0, limit: 40 } });
    expect(view.items.value[0]?.prompt).toBe('retry');
    expect(view.error.value).toBe('');
    await view.dispose();
  });
  it('clears retained results and cancels debounce when storage becomes unavailable', async () => {
    mocks.query.mockResolvedValueOnce(page({ label: 'initial' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    view.setQuery({ text: 'garden' });
    storageType = 'memory';
    await listener?.({ event: { type: 'migration', timestamp: 1 } });
    expect(view.items.value).toEqual([]);
    expect(view.available.value).toBe(false);
    expect(view.loading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    view.setQuery({ text: 'unavailable' });
    expect(view.loading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await view.dispose();
  });
  it('coalesces obsolete waiting searches behind one active Worker request', async () => {
    const first = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockReturnValueOnce(first.promise).mockResolvedValue(page({ label: 'latest' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    const loading = view.reload();
    for (const text of ['one', 'two', 'latest']) {
      view.setQuery({ text }); await vi.advanceTimersByTimeAsync(250);
    }
    expect(mocks.query).toHaveBeenCalledTimes(1);
    first.resolve(page({ label: 'old' })); await loading;
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1]?.[0].query.text).toBe('latest');
    expect(view.items.value[0]?.prompt).toBe('latest');
    await view.dispose();
  });
});
