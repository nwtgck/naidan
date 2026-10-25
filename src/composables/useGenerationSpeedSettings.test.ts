import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { useSettings } from './useSettings';
import { useGenerationSpeedSettings } from './useGenerationSpeedSettings';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), update: vi.fn(), addToast: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } });
type Update = Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0];

vi.mock('./useSettings', () => ({
  useSettings: () => ({ settings, captureExperimentalStorage: mocks.capture, updateExperimentalForStorage: mocks.update }),
}));
vi.mock('./useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

beforeEach(async () => {
  vi.resetAllMocks();
  settings.value = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } };
  mocks.capture.mockReturnValue(() => true);
  mocks.update.mockImplementation(async ({ isCurrent, updater }: Update) => {
    if (!isCurrent()) {
      return 'changed';
    }
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('generation speed display preferences', () => {
  it('keeps the approved display defaults without writing missing settings', () => {
    const api = useGenerationSpeedSettings();
    expect(api.status.value).toBe('enabled');
    expect(api.inlineStats.value).toBe('on_demand');
    expect(api.llamaCppServerTimings.value).toBe('auto');
    expect(settings.value.experimental).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('updates both consumers while preserving the other option and unrelated experimental settings', async () => {
    settings.value.experimental = { locale: 'ja', fakeLm: 'enabled', generationSpeed: { status: 'disabled', inlineStats: 'on_demand' } };
    const panel = useGenerationSpeedSettings();
    const developer = useGenerationSpeedSettings();
    await panel.update({ patch: { inlineStats: 'always' } });
    expect(developer.inlineStats.value).toBe('always');
    expect(developer.status.value).toBe('disabled');
    await developer.update({ patch: { status: 'enabled' } });
    expect(panel.status.value).toBe('enabled');
    expect(settings.value.experimental).toEqual({ locale: 'ja', fakeLm: 'enabled', generationSpeed: { status: 'enabled', inlineStats: 'always' } });
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('shares pending state and never retries a write into a replacement storage', async () => {
    const release = Promise.withResolvers<void>();
    let current = true;
    mocks.capture.mockReturnValue(() => current);
    mocks.update.mockImplementation(async ({ isCurrent, updater }: Update) => {
      await release.promise;
      if (!isCurrent()) {
        return 'changed';
      }
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    });
    const panel = useGenerationSpeedSettings();
    const developer = useGenerationSpeedSettings();
    const operation = panel.update({ patch: { status: 'disabled' } });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        release.resolve();
        await operation;
      },
    };
    expect(developer.saving.value).toBe(true);
    expect(panel.status.value).toBe('enabled');
    await developer.update({ patch: { inlineStats: 'always' } });
    current = false;
    settings.value = { ...settings.value, experimental: { generationSpeed: { status: 'enabled', inlineStats: 'on_demand' } } };
    release.resolve();
    await operation;
    expect(developer.saving.value).toBe(false);
    expect(settings.value.experimental?.generationSpeed).toEqual({ status: 'enabled', inlineStats: 'on_demand' });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    void cleanup;
  });

  it('keeps the saved values and reports a failed write', async () => {
    mocks.update.mockRejectedValue(new Error('storage unavailable'));
    const api = useGenerationSpeedSettings();
    await api.update({ patch: { status: 'disabled' } });
    expect(api.status.value).toBe('enabled');
    expect(api.saving.value).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Could not save the display settings. Try again.' });
  });

  it('shares server timing preferences without resetting display or unrelated settings', async () => {
    settings.value.experimental = { locale: 'ja', generationSpeed: { status: 'disabled', inlineStats: 'always' } };
    const panel = useGenerationSpeedSettings();
    const developer = useGenerationSpeedSettings();
    await panel.update({ patch: { llamaCppServerTimings: 'enabled' } });
    expect(developer.llamaCppServerTimings.value).toBe('enabled');
    await developer.update({ patch: { status: 'enabled' } });
    expect(panel.llamaCppServerTimings.value).toBe('enabled');
    expect(settings.value.experimental).toEqual({ locale: 'ja', generationSpeed: { status: 'enabled', inlineStats: 'always', llamaCppServerTimings: 'enabled' } });
  });
});
