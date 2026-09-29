import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { useSettings } from './useSettings';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { storageService } from '@/00-storage/service';
const mocks = vi.hoisted(() => ({ update: vi.fn(), listModels: vi.fn(async () => ['local-model']), loadProvider: vi.fn(), stored: undefined as Settings | undefined }));
vi.mock('@/00-storage/service', () => ({ storageService: { updateSettings: mocks.update, subscribeToChanges: vi.fn(() => () => {}) } }));
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
