import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { useSettings } from './useSettings';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { storageService } from '@/00-storage/service';
const mocks = vi.hoisted(() => ({ update: vi.fn(), listModels: vi.fn(async () => ['local-model']), loadProvider: vi.fn(), stored: undefined as Settings | undefined }));
vi.mock('@/00-storage/service', () => ({ storageService: { updateSettings: mocks.update, subscribeToChanges: vi.fn(() => () => {}), loadSettings: async () => mocks.stored ?? null, captureModelLaunchStorage: () => () => true } }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadProvider, prefetchLmProvider: vi.fn() }));
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: vi.fn(() => ({ cancel: vi.fn() })) }));
const original: Settings = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: [['X-Test', 'value']] }, defaultModelId: 'old-model', systemPrompt: 'Keep this setting' };
const target = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
beforeEach(async () => {
  vi.clearAllMocks();
  useSettings().TEST_ONLY.__testOnlyReset();
  useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: original });
  mocks.stored = structuredClone(original);
  mocks.update.mockImplementation(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
    if (!mocks.stored) throw new Error('Missing test settings'); mocks.stored = await updater({ current: mocks.stored });
  });
  mocks.loadProvider.mockResolvedValue({ listModels: mocks.listModels });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(async () => {
  await flushPromises(); useSettings().TEST_ONLY.__testOnlyReset();
});
describe('atomic default model and endpoint selection', () => {
  it('persists both fields in one update before publishing them and preserves unrelated settings', async () => {
    const gate = Promise.withResolvers<void>();
    mocks.update.mockImplementation(async ({ updater }: Parameters<typeof storageService.updateSettings>[0]) => {
      await gate.promise; if (!mocks.stored) throw new Error('Missing test settings'); mocks.stored = await updater({ current: mocks.stored });
    });
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    const changed = updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } });
    expect(settings.value.endpoint.type).toBe('ollama'); expect(settings.value.defaultModelId).toBe('old-model');
    gate.resolve(); expect(await changed).toBe('applied');
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(settings.value).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: 'Keep this setting' });
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target, systemPrompt: 'Keep this setting' });
    await flushPromises(); expect(mocks.loadProvider).toHaveBeenCalledWith(expect.objectContaining({ endpoint: { type: 'llama_cpp_browser' } }));
  });
  it('does not publish a half-change when storage fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Storage unavailable'));
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    await expect(updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } })).rejects.toThrow('Storage unavailable');
    expect(settings.value.endpoint).toEqual(original.endpoint); expect(settings.value.defaultModelId).toBe('old-model');
    expect(mocks.loadProvider).not.toHaveBeenCalled();
  });
  it('detects an intervening persisted default and updates the confirmation context without overwriting it', async () => {
    mocks.stored = { ...original, defaultModelId: 'newer-model' };
    const { settings, updateGlobalModelAndEndpoint } = useSettings();
    expect(await updateGlobalModelAndEndpoint({ endpoint: { type: 'llama_cpp_browser' }, modelId: target, expected: { endpoint: original.endpoint, modelId: original.defaultModelId } })).toBe('changed');
    expect(mocks.stored.defaultModelId).toBe('newer-model'); expect(settings.value.defaultModelId).toBe('newer-model');
    expect(settings.value.endpoint).toEqual(original.endpoint); expect(mocks.loadProvider).not.toHaveBeenCalled();
  });
});


describe('model launch global initialization', () => {
  function useBlankSettings() {
    const blank: Settings = { ...original, endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };
    useSettings().TEST_ONLY.__testOnlySetSettings({ newSettings: blank }); mocks.stored = structuredClone(blank);
    return useSettings();
  }
  it('initializes a genuinely empty pair after a captured authorization', async () => {
    const api = useBlankSettings(); const expected = await api.captureModelLaunchDefaults();
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('applied');
    expect(mocks.stored).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, defaultModelId: target });
  });
  it('preserves an existing endpoint even when its default model is empty', async () => {
    const api = useBlankSettings();
    const partial = { ...mocks.stored!, endpoint: original.endpoint };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: partial }); mocks.stored = partial;
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected: await api.captureModelLaunchDefaults() })).toBe('changed');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('detects local change-and-revert rather than relying only on equal final values', async () => {
    const api = useBlankSettings(); const expected = await api.captureModelLaunchDefaults(); const blank = { ...mocks.stored! };
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: { ...blank, defaultModelId: 'manual' } });
    api.TEST_ONLY.__testOnlySetSettings({ newSettings: blank });
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
  });
  it('preserves a different current default selected in another tab', async () => {
    const api = useBlankSettings(); const expected = await api.captureModelLaunchDefaults();
    mocks.stored = { ...mocks.stored!, defaultModelId: 'other-tab' };
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed');
    expect(mocks.stored.defaultModelId).toBe('other-tab');
  });
  it('does not publish defaults if their save fails', async () => {
    const api = useBlankSettings(); const expected = await api.captureModelLaunchDefaults(); mocks.update.mockRejectedValueOnce(new Error('quota'));
    await expect(api.initializeModelLaunchDefaults({ modelId: target, expected })).rejects.toThrow('quota');
    expect(api.settings.value.endpoint).toEqual({ type: 'openai', url: '' }); expect(api.settings.value.defaultModelId).toBeUndefined();
  });
  it('rejects a snapshot whose original storage provider is no longer active', async () => {
    const api = useBlankSettings(); const expected = { ...await api.captureModelLaunchDefaults(), isStorageCurrent: () => false };
    expect(await api.initializeModelLaunchDefaults({ modelId: target, expected })).toBe('changed'); expect(mocks.update).not.toHaveBeenCalled();
  });
});
