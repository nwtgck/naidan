import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelImportReceipt } from '@/features/llama-cpp-browser/model-files';
import type { LocalModel } from '@/features/llama-cpp-browser/types';

const service = vi.hoisted(() => ({
  replay: [] as ModelImportReceipt[],
  imports: new Set<({ receipt }: { receipt: ModelImportReceipt }) => void>(),
  models: new Set<() => void>(),
}));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  llamaCppBrowserModelFiles: {
    subscribeModelImports: vi.fn(({ listener }: { listener: ({ receipt }: { receipt: ModelImportReceipt }) => void }) => {
      service.imports.add(listener);
      service.replay.forEach(receipt => listener({ receipt }));
      return () => service.imports.delete(listener);
    }),
    subscribeModelList: vi.fn(({ listener }: { listener: () => void }) => {
      service.models.add(listener);
      return () => service.models.delete(listener);
    }),
  },
}));

const model: LocalModel = { modelId: 'user/example-GGUF', size: 16, importedAt: 1 };

function receipt({ generation, current, models }: { generation: number, current: () => boolean, models: readonly LocalModel[] }): ModelImportReceipt {
  return { storage: 'opfs', models, publication: { generation, isCurrent: current } };
}

function publish({ value }: { value: ModelImportReceipt }): void {
  service.imports.forEach(listener => listener({ receipt: value }));
}

function changed(): void {
  service.models.forEach(listener => listener());
}

beforeEach(() => {
  vi.resetModules();
  service.replay = [];
  service.imports.clear();
  service.models.clear();
});

describe('confirmed recent model imports', () => {
  it('replays prior confirmed imports and shares one ref and one subscription across surfaces', async () => {
    service.replay = [receipt({ generation: 1, current: () => true, models: [model] })];
    const { useRecentModelImports } = await import('./useRecentModelImports');
    const settings = useRecentModelImports();
    const drawer = useRecentModelImports();
    expect(settings.recentModels).toBe(drawer.recentModels);
    expect(settings.recentModels.value).toEqual([model]);
    expect(service.imports.size).toBe(1);
    expect(service.models.size).toBe(1);
    settings.dismiss();
    expect(drawer.recentModels.value).toEqual([]);
  });

  it('shows each success immediately and retains it when a later batch operation fails', async () => {
    const { useRecentModelImports } = await import('./useRecentModelImports');
    const view = useRecentModelImports();
    publish({ value: receipt({ generation: 1, current: () => true, models: [model] }) });
    // A rejected operation produces no receipt and cannot erase earlier success.
    expect(view.recentModels.value).toEqual([model]);
    const other = { ...model, modelId: 'user/other-GGUF' };
    publish({ value: receipt({ generation: 2, current: () => true, models: [other] }) });
    expect(view.recentModels.value).toEqual([model, other]);
  });

  it('rejects a late deleted receipt after the same model ID is registered again', async () => {
    const { useRecentModelImports } = await import('./useRecentModelImports');
    const view = useRecentModelImports();
    let currentGeneration = 1;
    const old = receipt({ generation: 1, current: () => currentGeneration === 1, models: [model] });
    publish({ value: old });
    currentGeneration = 2;
    changed();
    expect(view.recentModels.value).toEqual([]);
    const replacement = { ...model, size: 32 };
    currentGeneration = 3;
    publish({ value: receipt({ generation: 3, current: () => currentGeneration === 3, models: [replacement] }) });
    publish({ value: old });
    expect(view.recentModels.value).toEqual([replacement]);
  });

  it('removes old storage receipts and refuses their delayed replay', async () => {
    const { useRecentModelImports } = await import('./useRecentModelImports');
    const view = useRecentModelImports();
    let storageCurrent = true;
    const old = receipt({ generation: 1, current: () => storageCurrent, models: [model] });
    publish({ value: old });
    storageCurrent = false;
    changed();
    expect(view.recentModels.value).toEqual([]);
    publish({ value: old });
    expect(view.recentModels.value).toEqual([]);
  });

  it('keeps dismissed receipts closed while accepting a later successful import', async () => {
    const { useRecentModelImports } = await import('./useRecentModelImports');
    const view = useRecentModelImports();
    const old = receipt({ generation: 4, current: () => true, models: [model] });
    publish({ value: old });
    view.dismiss();
    publish({ value: old });
    expect(view.recentModels.value).toEqual([]);
    publish({ value: receipt({ generation: 5, current: () => true, models: [model] }) });
    expect(view.recentModels.value).toEqual([model]);
  });
});
