import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useAudioTranscriptionPreferences } from './useAudioTranscriptionPreferences';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), update: vi.fn(), addToast: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } });
type Update = Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0];

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings, captureExperimentalStorage: mocks.capture, updateExperimentalForStorage: mocks.update }),
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

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

describe('Audio transcription automatic copy preference', () => {
  it.each([undefined, {}, { locale: 'ja' }, { audioTranscription: {} }] satisfies Settings['experimental'][])('defaults to disabled without writing or materializing settings: %j', experimental => {
    settings.value.experimental = experimental;
    const api = useAudioTranscriptionPreferences();
    expect(api.autoCopy.value).toBe('disabled');
    expect(api.saving.value).toBe(false);
    expect(settings.value.experimental).toEqual(experimental);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'disabled'] as const)('reads the stored %s value without writing it again', value => {
    settings.value.experimental = { audioTranscription: { microphoneAutoCopy: value } };
    expect(useAudioTranscriptionPreferences().autoCopy.value).toBe(value);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('shares the setting and merges into the latest experimental preferences', async () => {
    settings.value.experimental = { locale: 'ja', fakeLm: 'enabled', unimplementedLauncherEntries: 'show' };
    mocks.update.mockImplementation(async ({ updater }: Update) => {
      settings.value = { ...settings.value, experimental: updater({ experimental: { ...settings.value.experimental, naidanRpc: 'enabled' } }) };
      return 'saved';
    });
    const first = useAudioTranscriptionPreferences(), second = useAudioTranscriptionPreferences();
    await first.updateAutoCopy({ value: 'enabled' });
    expect(second.autoCopy.value).toBe('enabled');
    await second.updateAutoCopy({ value: 'disabled' });
    expect(first.autoCopy.value).toBe('disabled');
    expect(settings.value.experimental).toEqual({ locale: 'ja', fakeLm: 'enabled', unimplementedLauncherEntries: 'show', naidanRpc: 'enabled', audioTranscription: { microphoneAutoCopy: 'disabled' } });
  });

  it('shares pending state, ignores duplicate saves, and leaves replacement storage untouched', async () => {
    const gate = Promise.withResolvers<void>();
    let current = true;
    mocks.capture.mockReturnValue(() => current);
    mocks.update.mockImplementation(async ({ isCurrent, updater }: Update) => {
      await gate.promise;
      if (!isCurrent()) {
        return 'changed';
      }
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    });
    const first = useAudioTranscriptionPreferences(), second = useAudioTranscriptionPreferences();
    const pending = first.updateAutoCopy({ value: 'enabled' });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        gate.resolve();
        await pending;
      },
    };
    expect(second.saving.value).toBe(true);
    await second.updateAutoCopy({ value: 'disabled' });
    current = false;
    settings.value = { ...settings.value, experimental: { locale: 'de', audioTranscription: { microphoneAutoCopy: 'disabled' } } };
    gate.resolve();
    await pending;
    expect(first.saving.value).toBe(false);
    expect(first.autoCopy.value).toBe('disabled');
    expect(settings.value.experimental).toEqual({ locale: 'de', audioTranscription: { microphoneAutoCopy: 'disabled' } });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    void cleanup;
  });

  it('keeps the previous saved value on failure and permits an explicit retry', async () => {
    settings.value.experimental = { audioTranscription: { microphoneAutoCopy: 'enabled' } };
    mocks.update.mockRejectedValueOnce(new Error('storage unavailable'));
    const api = useAudioTranscriptionPreferences();
    await api.updateAutoCopy({ value: 'disabled' });
    expect(api.autoCopy.value).toBe('enabled');
    expect(api.saving.value).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith({ message: 'Could not save the automatic copy setting. Try again.' });
    await api.updateAutoCopy({ value: 'disabled' });
    expect(api.autoCopy.value).toBe('disabled');
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('does not show an old storage failure after switching storage', async () => {
    mocks.capture.mockReturnValue(() => false);
    mocks.update.mockRejectedValue(new Error('old storage unavailable'));
    await useAudioTranscriptionPreferences().updateAutoCopy({ value: 'enabled' });
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(useAudioTranscriptionPreferences().saving.value).toBe(false);
  });
});
