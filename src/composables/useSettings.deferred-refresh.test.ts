import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { STORAGE_BOOTSTRAP_KEY } from '@/constants';
import type { ChangeListener } from '@/00-storage/service/synchronizer';
import type { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useSettings } from './useSettings';

const mocks = vi.hoisted(() => ({
  stored: undefined as Settings | undefined,
  settingsListener: undefined as ChangeListener | undefined,
  modelListeners: new Set<() => void | Promise<void>>(),
  listModels: vi.fn(async () => ['model']),
  loadProvider: vi.fn(),
  prefetchProvider: vi.fn(),
  idleTasks: [] as (() => Promise<void>)[],
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    init: vi.fn(async () => {}),
    subscribeLocalModelPromotions: vi.fn<typeof storageService.subscribeLocalModelPromotions>().mockReturnValue(() => {}),
    loadSettings: async () => mocks.stored ?? null,
    updateSettings: async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      mocks.stored = await updater({ current: mocks.stored ?? null });
    },
    updateSettingsForStorage: async ({ isCurrent, updater }: Parameters<typeof storageService.updateSettingsForStorage>[0]) => {
      if (!isCurrent()) {
        return 'changed';
      }
      const updated = await updater({ current: mocks.stored ?? null });
      if (!isCurrent()) {
        return 'changed';
      }
      mocks.stored = updated;
      return 'saved';
    },
    getCurrentType: () => 'local',
    subscribeToChanges: ({ listener }: { listener: ChangeListener }) => {
      mocks.settingsListener = listener;
      return () => {};
    },
  },
}));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ configureRpcFeature: vi.fn(async () => {}) }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadProvider, prefetchLmProvider: mocks.prefetchProvider }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      mocks.modelListeners.add(listener);
      return () => mocks.modelListeners.delete(listener);
    },
  },
}));
vi.mock('@/features/transformers-js', () => ({
  transformersJsService: {
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      mocks.modelListeners.add(listener);
      return () => mocks.modelListeners.delete(listener);
    },
  },
}));
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    mocks.idleTasks.push(task);
    return { cancel: vi.fn() };
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  useSettings().TEST_ONLY.__testOnlyReset();
  await flushPromises();
  mocks.idleTasks.length = 0;
  mocks.stored = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://saved.example/v1' }, defaultModelId: 'saved-model' };
  mocks.loadProvider.mockResolvedValue({ listModels: mocks.listModels });
  localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'local');
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('deferred automatic model refresh', () => {
  it('loads saved HTTP settings without listing models or scheduling provider work', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    await flushPromises();
    expect(api.settings.value.defaultModelId).toBe('saved-model');
    expect(mocks.loadProvider).not.toHaveBeenCalled();
    expect(mocks.idleTasks).toHaveLength(0);
  });

  it('defers enabled fake runtime prefetch during initialization and synchronization', async () => {
    mocks.stored = { ...mocks.stored!, experimental: { fakeLm: 'enabled' } };
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    await mocks.settingsListener!({ event: { type: 'settings', timestamp: 1 } });
    await flushPromises();
    expect(mocks.loadProvider).not.toHaveBeenCalled();
    expect(mocks.idleTasks).toHaveLength(0);
  });

  it('keeps background and awaited saves deferred until ordinary navigation resumes', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    await api.save({ patch: { endpoint: { type: 'openai', url: 'https://changed.example/v1' } }, modelRefresh: 'background' });
    await api.save({ patch: { endpoint: { type: 'ollama', url: 'https://another.example' } }, modelRefresh: 'await' });
    expect(mocks.loadProvider).not.toHaveBeenCalled();
    api.resumeModelRefresh();
    api.resumeModelRefresh();
    await flushPromises();
    expect(mocks.loadProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endpoint: { type: 'ollama', url: 'https://another.example' } }));
    expect(mocks.listModels).toHaveBeenCalledOnce();
  });

  it('suppresses model-list subscriptions after synchronized browser-provider changes', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    for (const endpointType of ['llama_cpp_browser', 'transformers_js'] as const) {
      mocks.stored = { ...mocks.stored!, endpoint: { type: endpointType } };
      await mocks.settingsListener!({ event: { type: 'settings', timestamp: 1 } });
      await flushPromises();
      expect(mocks.modelListeners.size).toBe(1);
      for (const listener of mocks.modelListeners) {
        await listener();
      }
    }
    expect(mocks.loadProvider).not.toHaveBeenCalled();
    expect(mocks.idleTasks).toHaveLength(0);
    api.resumeModelRefresh();
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledOnce();
    for (const listener of mocks.modelListeners) {
      await listener();
    }
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit connection request without releasing deferred global work', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    await api.fetchModels({ overrides: { type: 'openai', url: 'https://explicit.example/v1' } });
    expect(mocks.loadProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endpoint: { type: 'openai', url: 'https://explicit.example/v1' } }));
    await api.save({ patch: { endpoint: { type: 'openai', url: 'https://updated.example/v1' } }, modelRefresh: 'background' });
    expect(mocks.loadProvider).toHaveBeenCalledOnce();
    expect(mocks.idleTasks).toHaveLength(0);
  });

  it('refreshes one changed endpoint when returning from an entry view', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'background' });
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledOnce();
    api.deferModelRefresh();
    for (const task of mocks.idleTasks.splice(0)) {
      await task();
    }
    expect(mocks.prefetchProvider).not.toHaveBeenCalled();
    await api.save({ patch: { endpoint: { type: 'openai', url: 'https://changed.example/v1' } }, modelRefresh: 'background' });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    api.resumeModelRefresh();
    api.resumeModelRefresh();
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
    expect(mocks.loadProvider).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: { type: 'openai', url: 'https://changed.example/v1' } }));
  });

  it('defers the newly confirmed model connection until ordinary model refresh resumes', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'background' });
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledOnce();
    api.deferModelRefresh();
    expect(await api.commitGlobalModelConnection({ endpoint: { type: 'openai', url: 'https://confirmed.example/v1' }, modelId: 'confirmed-model', isCurrent: () => true })).toBe('applied');
    expect(mocks.listModels).toHaveBeenCalledOnce();
    api.resumeModelRefresh();
    api.resumeModelRefresh();
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
    expect(mocks.loadProvider).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: { type: 'openai', url: 'https://confirmed.example/v1' } }));
  });

  it('does not repeat the initial refresh when an unchanged entry view is closed', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'background' });
    await flushPromises();
    api.deferModelRefresh();
    for (const task of mocks.idleTasks.splice(0)) {
      await task();
    }
    api.resumeModelRefresh();
    api.resumeModelRefresh();
    await flushPromises();
    expect(mocks.listModels).toHaveBeenCalledOnce();
  });
});
