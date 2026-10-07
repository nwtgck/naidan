import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationHistoryPage, ImageGenerationHistoryQuery, ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ChangeListener } from '@/00-storage/service/synchronizer';
import type { StorageType } from '@/01-models/types';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import { createImageForm } from '@/features/image-generation/form';

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
    id: toImageGenerationId({ raw: label }),
    createdAt: 1000,
    request: {
      parameters: { ...form.parameters.value, prompt: label },
      models: [],
      loras: [],
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
  it('bounds the visible collection to 40 records while navigating a large library', async () => {
    const records = Array.from({ length: 10_005 }, (_, index) => page({ label: `image-${index}` }).items[0]!);
    mocks.query.mockImplementation(async ({ query }: { query: ImageGenerationHistoryQuery }) => ({
      items: records.slice(query.offset, query.offset + query.limit),
      total: records.length,
      warnings: [],
      warningCount: 0,
    }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    expect(view.pageCount.value).toBe(251);
    for (const target of [2, 200, 251, 1]) {
      await view.goToPage({ page: target });
      expect(view.currentPage.value).toBe(target);
      expect(view.items.value).toEqual(records.slice((target - 1) * 40, target * 40));
      expect(view.items.value.length).toBeLessThanOrEqual(40);
      expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: '', offset: (target - 1) * 40, limit: 40 } });
    }
    const calls = mocks.query.mock.calls.length;
    for (const target of [0, -1, 252, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1]) await view.goToPage({ page: target });
    expect(mocks.query).toHaveBeenCalledTimes(calls);
    await view.dispose();
  });
  it('keeps page, count and images together while a failed page is retried', async () => {
    const first = { ...page({ label: 'first' }), total: 81 }, second = { ...page({ label: 'second' }), total: 80 };
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(second);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    const moving = view.goToPage({ page: 2 });
    expect(view.items.value).toBe(first.items);
    expect(view.currentPage.value).toBe(1);
    expect(view.total.value).toBe(81);
    expect(view.pageCount.value).toBe(3);
    pending.reject(new Error('Page could not be read'));
    await moving;
    expect(view.items.value).toBe(first.items);
    expect(view.currentPage.value).toBe(1);
    expect(view.error.value).toBe('Page could not be read');
    await view.reload();
    expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: '', offset: 40, limit: 40 } });
    expect(view.items.value).toBe(second.items);
    expect(view.currentPage.value).toBe(2);
    expect(view.pageCount.value).toBe(2);
    expect(view.error.value).toBe('');
    await view.dispose();
  });
  it('resets a changed search to page one and ignores an older in-flight page', async () => {
    const first = { ...page({ label: 'first' }), total: 120 }, second = { ...page({ label: 'second' }), total: 120 };
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page({ label: 'found' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload(); await view.goToPage({ page: 2 });
    const moving = view.goToPage({ page: 3 });
    view.setQuery({ text: 'garden' });
    pending.resolve({ ...page({ label: 'stale-third' }), total: 120 });
    await moving;
    expect(view.items.value).toBe(second.items);
    expect(view.currentPage.value).toBe(2);
    expect(view.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: 'garden', offset: 0, limit: 40 } });
    expect(view.currentPage.value).toBe(1);
    expect(view.items.value[0]?.prompt).toBe('found');
    await view.dispose();
  });
  it('stays on the current page when refreshed after new images are added', async () => {
    const records = Array.from({ length: 85 }, (_, index) => page({ label: `image-${index}` }).items[0]!);
    mocks.query.mockImplementation(async ({ query }: { query: ImageGenerationHistoryQuery }) => ({
      items: records.slice(query.offset, query.offset + query.limit),
      total: records.length,
      warnings: [],
      warningCount: 0,
    }));
    const selected = record({ label: 'selected' });
    mocks.load.mockResolvedValueOnce(selected);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload(); await view.goToPage({ page: 2 }); await view.select({ id: selected.id });
    records.unshift(page({ label: 'new-image' }).items[0]!);
    await view.reload();
    expect(view.currentPage.value).toBe(2);
    expect(view.items.value).toEqual(records.slice(40, 80));
    expect(view.total.value).toBe(86);
    expect(view.selected.value).toBe(selected);
    await view.dispose();
  });
  it('moves back to the last remaining page after a deletion without displaying an empty intermediate page', async () => {
    const first = { ...page({ label: 'first' }), total: 81 }, last = { ...page({ label: 'last' }), total: 81 };
    const previous = { ...page({ label: 'previous' }), total: 80 };
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(first).mockResolvedValueOnce(last).mockResolvedValueOnce({ items: [], total: 80, warnings: [], warningCount: 0 }).mockReturnValueOnce(pending.promise);
    mocks.remove.mockResolvedValueOnce(undefined);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload(); await view.goToPage({ page: 3 });
    const removing = view.remove({ id: last.items[0]!.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: '', offset: 40, limit: 40 } });
    expect(view.currentPage.value).toBe(3);
    expect(view.items.value).toBe(last.items);
    expect(view.total.value).toBe(81);
    pending.resolve(previous); await removing;
    expect(view.currentPage.value).toBe(2);
    expect(view.pageCount.value).toBe(2);
    expect(view.items.value).toBe(previous.items);
    mocks.query.mockResolvedValueOnce({ items: [], total: 0, warnings: [], warningCount: 0 });
    await view.reload();
    expect(view.currentPage.value).toBe(1);
    expect(view.pageCount.value).toBe(1);
    expect(view.items.value).toEqual([]);
    await view.dispose();
  });
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
  it.each(['succeeds', 'fails'] as const)('keeps a newer selection pending when the previous record is deleted and its read %s', async outcome => {
    const first = record({ label: 'first' }), second = record({ label: 'second' });
    const deleting = deferred<void>(), selecting = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockReturnValueOnce(selecting.promise);
    mocks.remove.mockReturnValueOnce(deleting.promise);
    mocks.query.mockResolvedValue(page({ label: 'second' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const deletion = view.remove({ id: first.id });
    const selection = view.select({ id: second.id });
    deleting.resolve(); await deletion;
    expect(mocks.remove).toHaveBeenCalledWith({ id: first.id });
    expect(view.selected.value).toBeUndefined();
    expect(view.detailLoading.value).toBe(true);
    switch (outcome) {
    case 'succeeds':
      selecting.resolve(second); await selection;
      expect(view.selected.value).toEqual(second);
      expect(view.detailError.value).toBe('');
      break;
    case 'fails':
      selecting.reject(new Error('Second record is unreadable')); await selection;
      expect(view.selected.value).toBeUndefined();
      expect(view.detailError.value).toBe('Second record is unreadable');
      break;
    default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
    }
    expect(view.detailLoading.value).toBe(false);
    await view.dispose();
  });
  it('clears a deleted detail and keeps a completed newer selection when the list reload fails', async () => {
    const first = record({ label: 'first' }), second = record({ label: 'second' });
    mocks.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mocks.remove.mockResolvedValue(undefined);
    mocks.query.mockRejectedValue(new Error('List reload failed'));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    await view.remove({ id: first.id });
    expect(view.selected.value).toBeUndefined();
    expect(view.detailLoading.value).toBe(false);
    expect(view.error.value).toBe('List reload failed');
    await view.select({ id: second.id });
    await view.remove({ id: first.id });
    expect(view.selected.value).toEqual(second);
    expect(view.error.value).toBe('List reload failed');
    await view.dispose();
  });
  it('preserves a newer pending selection if deleting the previous record fails', async () => {
    const first = record({ label: 'first' }), second = record({ label: 'second' });
    const deleting = deferred<void>(), selecting = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockReturnValueOnce(selecting.promise);
    mocks.remove.mockReturnValueOnce(deleting.promise);
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const deletion = view.remove({ id: first.id });
    const rejection = expect(deletion).rejects.toThrow('Cannot delete first');
    const selection = view.select({ id: second.id });
    deleting.reject(new Error('Cannot delete first')); await rejection;
    expect(view.selected.value).toEqual(first);
    expect(view.detailLoading.value).toBe(true);
    selecting.resolve(second); await selection;
    expect(view.selected.value).toEqual(second);
    expect(mocks.query).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('rejects a late read of the deleted record without clearing another displayed record', async () => {
    const first = record({ label: 'first' }), second = record({ label: 'second' });
    const deleting = deferred<void>(), selecting = deferred<ImageGenerationRecord>();
    mocks.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockReturnValueOnce(selecting.promise);
    mocks.remove.mockReturnValueOnce(deleting.promise);
    mocks.query.mockResolvedValue(page({ label: 'second' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.select({ id: first.id });
    const deletion = view.remove({ id: first.id });
    await view.select({ id: second.id });
    const selection = view.select({ id: first.id });
    deleting.resolve(); await deletion;
    selecting.resolve(first); await selection;
    expect(view.selected.value).toEqual(second);
    expect(view.detailLoading.value).toBe(false);
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
    const initial = { ...page({ label: 'initial' }), total: 85 };
    const pending = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page({ label: 'retry' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    view.setQuery({ text: 'garden' });
    await view.goToPage({ page: 2 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    await view.goToPage({ page: 2 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    pending.reject(new Error('Cannot read index'));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.items.value).toBe(initial.items);
    expect(view.total.value).toBe(85);
    expect(view.error.value).toBe('Cannot read index');
    expect(view.loading.value).toBe(false);
    await view.goToPage({ page: 2 });
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
