import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { useSettings } from './useSettings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { storageService } from '@/00-storage/service';
const mocks = vi.hoisted(() => ({ update: vi.fn(), updateForStorage: vi.fn(), load: vi.fn<() => Promise<Settings | null>>(), listModels: vi.fn(async () => ['local-model']), loadProvider: vi.fn(), scheduleIdleTask: vi.fn(() => ({ cancel: vi.fn() })), stored: undefined as Settings | undefined, storageGeneration: 0 }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    init: vi.fn(async () => {}),
    updateSettings: mocks.update,
    updateSettingsForStorage: mocks.updateForStorage,
    getCurrentType: () => mocks.stored?.storageType ?? 'local',
    subscribeToChanges: vi.fn(() => () => {}),
    loadSettings: mocks.load,
    captureSettingsStorage: () => {
      const generation = mocks.storageGeneration;
      return () => generation === mocks.storageGeneration;
    },
  },
}));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadProvider, prefetchLmProvider: vi.fn() }));
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: mocks.scheduleIdleTask }));
const original: Settings = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: [['X-Test', 'value']] }, defaultModelId: 'old-model', systemPrompt: 'Keep this setting' };
const target = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { language: 'en', locks: { request: vi.fn() } });
  useSettings().TEST_ONLY.__testOnlyReset();
  useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: original });
  mocks.stored = structuredClone(original);
  mocks.load.mockImplementation(async () => mocks.stored ?? null);
  mocks.update.mockImplementation(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
    if (!mocks.stored) {
      throw new Error('Missing test settings');
    }
    mocks.stored = await updater({ current: mocks.stored });
  });
  mocks.updateForStorage.mockImplementation(async ({ isCurrent, updater }: Parameters<typeof storageService.updateSettingsForStorage>[0]) => {
    if (!isCurrent()) {
      return 'changed';
    }
    await mocks.update({ updater });
    return 'saved';
  });
  mocks.loadProvider.mockResolvedValue({ listModels: mocks.listModels });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(async () => {
  await flushPromises();
  useSettings().TEST_ONLY.__testOnlyReset();
  vi.unstubAllGlobals();
});

describe('atomic default model and endpoint selection', () => {
  it('persists both fields in one update before publishing them and preserves unrelated settings', async () => {
    const gate = Promise.withResolvers<void>();
    mocks.update.mockImplementation(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      await gate.promise;
      if (!mocks.stored) {
        throw new Error('Missing test settings');
      }
      mocks.stored = await updater({ current: mocks.stored });
    });
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    const changed = updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } });
    expect(settings.value.endpoint.type).toBe('ollama');
    expect(settings.value.defaultModelId).toBe('old-model');
    gate.resolve();
    expect(await changed).toBe('applied');
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(settings.value).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: 'Keep this setting' });
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: 'Keep this setting' });
    await flushPromises();
    expect(mocks.loadProvider).toHaveBeenCalledWith(expect.objectContaining({ endpoint: { type: 'llama_cpp_browser' } }));
  });

  it('does not publish a half-change when storage fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Storage unavailable'));
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    await expect(updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } })).rejects.toThrow('Storage unavailable');
    expect(settings.value.endpoint).toEqual(original.endpoint);
    expect(settings.value.defaultModelId).toBe('old-model');
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });

  it('detects an intervening persisted default and updates the confirmation context without overwriting it', async () => {
    mocks.stored = { ...original, defaultModelId: 'newer-model' };
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    expect(await updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } })).toBe('changed');
    expect(mocks.stored.defaultModelId).toBe('newer-model');
    expect(settings.value.defaultModelId).toBe('newer-model');
    expect(settings.value.endpoint).toEqual(original.endpoint);
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });
});

describe('model launch global initialization', () => {
  function useBlankSettings() {
    const blank: Settings = { ...original, endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };
    useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: blank });
    mocks.stored = structuredClone(blank);
    return useSettings();
  }

  it('initializes a genuinely empty pair after a captured authorization', async () => {
    const api = useBlankSettings();
    const expected = await api.captureModelLaunchDefaults();
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('applied');
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target });
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });

  it('initializes an actual temporary model before it has been saved', async () => {
    const api = useBlankSettings();
    const modelId = 'temp:drop-root/model.gguf';
    expect(await api.initializeModelLaunchDefaults({ modelId, expected: await api.captureModelLaunchDefaults() })).toBe('applied');
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: modelId });
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });

  it('preserves an existing endpoint even when its default model is empty', async () => {
    const api = useBlankSettings();
    const partial = { ...mocks.stored!, endpoint: original.endpoint };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: partial });
    mocks.stored = partial;
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected: await api.captureModelLaunchDefaults() })).toBe('changed');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('detects local change-and-revert rather than relying only on equal final values', async () => {
    const api = useBlankSettings();
    const expected = await api.captureModelLaunchDefaults();
    const blank = { ...mocks.stored! };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...blank, defaultModelId: 'manual' } });
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: blank });
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
  });

  it('preserves a different current default selected in another tab', async () => {
    const api = useBlankSettings();
    const expected = await api.captureModelLaunchDefaults();
    mocks.stored = { ...mocks.stored!, defaultModelId: 'other-tab' };
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
    expect(mocks.stored.defaultModelId).toBe('other-tab');
  });

  it('does not publish defaults if their save fails', async () => {
    const api = useBlankSettings();
    const expected = await api.captureModelLaunchDefaults();
    mocks.update.mockRejectedValueOnce(new Error('quota'));
    await expect(api.initializeModelLaunchDefaults({ modelId: target, expected })).rejects.toThrow('quota');
    expect(api.settings.value.endpoint).toEqual({ type: 'openai', url: '' });
    expect(api.settings.value.defaultModelId).toBeUndefined();
  });

  it('rejects a snapshot whose original storage provider is no longer active', async () => {
    const api = useBlankSettings();
    const expected = { ...await api.captureModelLaunchDefaults(), isStorageCurrent: () => false };
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects initialization after the same storage provider has been replaced', async () => {
    const api = useBlankSettings();
    const expected = await api.captureModelLaunchDefaults();
    mocks.storageGeneration++;
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
    expect(mocks.updateForStorage).not.toHaveBeenCalled();
  });
});

describe('temporary model global promotion', () => {
  const sourceModelId = 'temp:drop-root/model.gguf';
  const savedModelId = 'user/drop-root-2/model.gguf';

  function selectTemporaryDefault() {
    const settings: Settings = { ...original, endpoint: { type: 'llama_cpp_browser' }, defaultModelId: sourceModelId };
    useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: settings });
    mocks.stored = structuredClone(settings);
    return useSettings();
  }

  it('promotes a manually selected matching source and preserves all unrelated settings', async () => {
    const api = selectTemporaryDefault();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    expect(expected).toBeDefined();
    mocks.stored = { ...mocks.stored!, systemPrompt: 'A newer unrelated edit' };
    expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).toBe('applied');
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: savedModelId, systemPrompt: 'A newer unrelated edit' });
    expect(api.settings.value.defaultModelId).toBe(savedModelId);
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });

  it('requires Web Locks for persistent promotion while allowing memory promotion without them', async () => {
    vi.stubGlobal('navigator', { language: 'en' });
    for (const [storageType, outcome, expectedModelId, writes] of [
      ['local', 'changed', sourceModelId, 0],
      ['opfs', 'changed', sourceModelId, 0],
      ['memory', 'applied', savedModelId, 1],
    ] as const) {
      const api = selectTemporaryDefault();
      mocks.stored = { ...mocks.stored!, storageType };
      api.TEST_ONLY.__testOnlySetSettings({ newSettings: mocks.stored });
      const expected = await api.captureGlobalModelBinding({ sourceModelId });
      expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).toBe(outcome);
      expect(mocks.stored.defaultModelId).toBe(expectedModelId);
      expect(api.settings.value.defaultModelId).toBe(expectedModelId);
      expect(mocks.updateForStorage).toHaveBeenCalledTimes(writes);
    }
  });

  it('requires the complete source ID and browser endpoint', async () => {
    const api = selectTemporaryDefault();
    expect(await api.captureGlobalModelBinding({ sourceModelId: 'temp:drop-root/other.gguf' })).toBeUndefined();
    const otherEndpoint: Settings = { ...mocks.stored!, endpoint: original.endpoint };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: otherEndpoint });
    mocks.stored = otherEndpoint;
    expect(await api.captureGlobalModelBinding({ sourceModelId })).toBeUndefined();
    expect(mocks.updateForStorage).not.toHaveBeenCalled();
  });

  it('preserves a different persisted model selected during copying', async () => {
    const api = selectTemporaryDefault();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    mocks.stored = { ...mocks.stored!, defaultModelId: 'a-newer-default' };
    expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).toBe('changed');
    expect(mocks.stored.defaultModelId).toBe('a-newer-default');
    expect(api.settings.value.defaultModelId).toBe(sourceModelId);
  });

  it('detects local change-and-revert during copying', async () => {
    const api = selectTemporaryDefault();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    const selected = { ...mocks.stored! };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...selected, defaultModelId: 'manual-change' } });
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: selected });
    expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).toBe('changed');
    expect(mocks.updateForStorage).not.toHaveBeenCalled();
  });

  it('rechecks the revision inside the queued settings write', async () => {
    const api = selectTemporaryDefault();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    mocks.update.mockImplementationOnce(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      entered.resolve();
      await gate.promise;
      mocks.stored = await updater({ current: mocks.stored! });
    });
    const promotion = api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! });
    await entered.promise;
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...mocks.stored!, defaultModelId: 'manual-change' } });
    gate.resolve();
    expect(await promotion).toBe('changed');
    expect(mocks.stored?.defaultModelId).toBe(sourceModelId);
    expect(api.settings.value.defaultModelId).toBe('manual-change');
  });

  it('rejects an expired storage generation and can retry a failed save without copying', async () => {
    const api = selectTemporaryDefault();
    const stale = await api.captureGlobalModelBinding({ sourceModelId });
    mocks.storageGeneration++;
    expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: stale! })).toBe('changed');
    expect(mocks.updateForStorage).not.toHaveBeenCalled();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    mocks.update.mockRejectedValueOnce(new Error('quota'));
    await expect(api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).rejects.toThrow('quota');
    expect(api.settings.value.defaultModelId).toBe(sourceModelId);
    expect(await api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! })).toBe('applied');
  });

  it('preserves a newer local selection after the persisted write has started', async () => {
    const api = selectTemporaryDefault();
    const expected = await api.captureGlobalModelBinding({ sourceModelId });
    const gate = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    mocks.update.mockImplementationOnce(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      mocks.stored = await updater({ current: mocks.stored! });
      written.resolve();
      await gate.promise;
    });
    const promotion = api.promoteGlobalModelBinding({ modelId: savedModelId, expected: expected! });
    await written.promise;
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...mocks.stored!, defaultModelId: 'manual-change' } });
    gate.resolve();
    expect(await promotion).toBe('changed');
    expect(api.settings.value.defaultModelId).toBe('manual-change');
  });
});

describe('model binding admission settings synchronization', () => {
  it('publishes the latest binding pair without fetching models, prefetching providers, or replacing other live settings', async () => {
    const api = useSettings();
    await api.init({ storageTypeOverride: 'local', dataZipBase64: undefined, modelRefresh: 'background' });
    await flushPromises();
    mocks.loadProvider.mockClear();
    mocks.scheduleIdleTask.mockClear();
    mocks.stored = { ...original, endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: 'A persisted prompt from elsewhere', experimental: { fakeLm: 'enabled' } };
    expect(await api.synchronizeModelBindingSettings({ isCurrent: () => true })).toBe('synchronized');
    await flushPromises();
    expect(api.settings.value).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: original.systemPrompt });
    expect(api.settings.value.experimental).toEqual(original.experimental);
    expect(mocks.loadProvider).not.toHaveBeenCalled();
    expect(mocks.scheduleIdleTask).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateForStorage).not.toHaveBeenCalled();
  });

  it('preserves the live pair when its operation or storage provider expires during the read', async () => {
    const api = useSettings();
    const fresh: Settings = { ...original, endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target };
    let current = true;
    const operationRead = Promise.withResolvers<Settings | null>();
    mocks.load.mockReturnValueOnce(operationRead.promise);
    const first = api.synchronizeModelBindingSettings({ isCurrent: () => current });
    current = false;
    operationRead.resolve(fresh);
    expect(await first).toBe('changed');
    const storageRead = Promise.withResolvers<Settings | null>();
    mocks.load.mockReturnValueOnce(storageRead.promise);
    const second = api.synchronizeModelBindingSettings({ isCurrent: () => true });
    mocks.storageGeneration++;
    storageRead.resolve(fresh);
    expect(await second).toBe('changed');
    expect(api.settings.value.endpoint).toEqual(original.endpoint);
    expect(api.settings.value.defaultModelId).toBe(original.defaultModelId);
  });

  it('preserves a local selection made during the settings read', async () => {
    const api = useSettings();
    const loaded = Promise.withResolvers<Settings | null>();
    mocks.load.mockReturnValueOnce(loaded.promise);
    const synchronization = api.synchronizeModelBindingSettings({ isCurrent: () => true });
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...original, defaultModelId: 'manual-change' } });
    loaded.resolve({ ...original, defaultModelId: target });
    expect(await synchronization).toBe('changed');
    expect(api.settings.value.defaultModelId).toBe('manual-change');
  });

  it('preserves an optimistic selection until its save succeeds and retains failed saves for retry', async () => {
    const api = useSettings();
    const write = Promise.withResolvers<void>();
    mocks.update.mockImplementationOnce(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      await write.promise;
      mocks.stored = await updater({ current: mocks.stored! });
    });
    const saving = api.updateGlobalModel({ modelId: 'manual-change' });
    expect(await api.synchronizeModelBindingSettings({ isCurrent: () => true })).toBe('changed');
    expect(mocks.load).not.toHaveBeenCalled();
    write.resolve();
    await saving;
    mocks.stored = { ...mocks.stored!, defaultModelId: target };
    expect(await api.synchronizeModelBindingSettings({ isCurrent: () => true })).toBe('synchronized');
    expect(api.settings.value.defaultModelId).toBe(target);
    mocks.update.mockRejectedValueOnce(new Error('quota'));
    const endpoint = { type: 'openai', url: 'https://manual.example/v1' } as const;
    await expect(api.updateGlobalEndpoint({ endpoint })).rejects.toThrow('quota');
    expect(await api.synchronizeModelBindingSettings({ isCurrent: () => true })).toBe('changed');
    expect(api.settings.value.endpoint).toEqual(endpoint);
  });
});

describe('saving a temporary model default', () => {
  it.each(['matching', 'selector', 'endpoint', 'empty'] as const)('promotes only the complete matching default pair: %s', async match => {
    const sourceModelId = 'temp/source:Q4_K_M';
    const saved: Settings = { ...original, endpoint: match === 'endpoint' ? original.endpoint : { type: 'llama_cpp_browser' }, defaultModelId: match === 'empty' ? undefined : match === 'selector' ? 'temp/source:Q8_0' : sourceModelId, experimental: { locale: 'ja' } };
    const api = useSettings();
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: saved });
    mocks.stored = structuredClone(saved);
    await api.promoteTemporaryModelDefault({ sourceModelId, modelId: 'user/source-2', isCurrent: () => true });
    expect(mocks.stored).toEqual({ ...saved, defaultModelId: match === 'matching' ? 'user/source-2' : saved.defaultModelId });
    expect(api.settings.value.defaultModelId).toBe(mocks.stored.defaultModelId);
  });

  it('does not transfer promotion to another provider or revert a newer global choice', async () => {
    const api = useSettings();
    const saved: Settings = { ...original, endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'temp/source:Q4' };
    mocks.stored = saved;
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: saved });
    await api.promoteTemporaryModelDefault({ sourceModelId: 'temp/source:Q4', modelId: 'user/source', isCurrent: () => false });
    expect(mocks.stored.defaultModelId).toBe('temp/source:Q4');
    mocks.stored = { ...saved, defaultModelId: 'user/newer' };
    await api.promoteTemporaryModelDefault({ sourceModelId: 'temp/source:Q4', modelId: 'user/source', isCurrent: () => true });
    expect(mocks.stored.defaultModelId).toBe('user/newer');
  });
});
