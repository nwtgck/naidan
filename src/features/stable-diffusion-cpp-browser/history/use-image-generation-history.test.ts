import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationHistoryPage } from '@/01-models/image-generation-history';
import type { ChangeListener } from '@/00-storage/service/synchronizer';
import type { StorageType } from '@/01-models/types';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';

const mocks = vi.hoisted(() => ({ query: vi.fn(), dispose: vi.fn(), load: vi.fn(), remove: vi.fn(), getFile: vi.fn(), subscribe: vi.fn() }));
vi.mock('./worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, dispose: mocks.dispose }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadImageGeneration: mocks.load, deleteImageGeneration: mocks.remove, getFile: mocks.getFile, subscribeToChanges: mocks.subscribe } }));
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
});
afterEach(() => {
  vi.useRealTimers();
});

describe('image history query ownership', () => {
  it('drops a previous response immediately when input changes, including during debounce', async () => {
    const old = deferred<ImageGenerationHistoryPage>();
    mocks.query.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page({ label: 'new' }));
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    const loading = view.reload();
    view.setQuery({ text: 'new' });
    old.resolve(page({ label: 'old' })); await loading;
    expect(view.items.value).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.items.value[0]?.prompt).toBe('new');
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
  it('exposes partial read warnings without hiding readable results and clears them for a new query', async () => {
    mocks.query.mockResolvedValueOnce({ ...page({ label: 'readable' }), warnings: [{ path: 'ab/incomplete-aB.json', message: 'Empty JSON' }], warningCount: 1 });
    const view = useImageGenerationHistory({ getStorageType: () => storageType });
    await view.reload();
    expect(view.items.value[0]?.prompt).toBe('readable'); expect(view.error.value).toBe('');
    expect(view.warningCount.value).toBe(1); expect(view.warnings.value[0]?.path).toBe('ab/incomplete-aB.json');
    view.setQuery({ text: 'new query' });
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
