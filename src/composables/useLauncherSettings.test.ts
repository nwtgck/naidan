import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { useSettings } from './useSettings';
import { useLauncherSettings } from './useLauncherSettings';

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

describe('Home and launcher entry visibility', () => {
  it('hides unfinished entries by default without materializing a saved preference', () => {
    const api = useLauncherSettings();
    expect(api.unimplementedLauncherEntries.value).toBe('hide');
    expect(api.saving.value).toBe(false);
    expect(settings.value.experimental).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('shares visibility between consumers and updates the latest experimental values', async () => {
    settings.value.experimental = { locale: 'ja', fakeLm: 'enabled' };
    mocks.update.mockImplementation(async ({ updater }: Update) => {
      settings.value = { ...settings.value, experimental: updater({ experimental: { ...settings.value.experimental, naidanRpc: 'enabled' } }) };
      return 'saved';
    });
    const home = useLauncherSettings();
    const launcher = useLauncherSettings();
    await launcher.update({ visibility: 'show' });
    expect(home.unimplementedLauncherEntries.value).toBe('show');
    await home.update({ visibility: 'hide' });
    expect(launcher.unimplementedLauncherEntries.value).toBe('hide');
    expect(settings.value.experimental).toEqual({ locale: 'ja', fakeLm: 'enabled', naidanRpc: 'enabled', unimplementedLauncherEntries: 'hide' });
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('shares saving state and does not carry a pending update into replacement storage', async () => {
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
    const home = useLauncherSettings();
    const launcher = useLauncherSettings();
    const operation = home.update({ visibility: 'show' });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        release.resolve();
        await operation;
      },
    };
    expect(launcher.saving.value).toBe(true);
    await launcher.update({ visibility: 'hide' });
    current = false;
    settings.value = { ...settings.value, experimental: { locale: 'de', unimplementedLauncherEntries: 'hide' } };
    release.resolve();
    await operation;
    expect(launcher.saving.value).toBe(false);
    expect(home.unimplementedLauncherEntries.value).toBe('hide');
    expect(settings.value.experimental).toEqual({ locale: 'de', unimplementedLauncherEntries: 'hide' });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    void cleanup;
  });

  it('keeps the saved visibility and reports a failed write', async () => {
    mocks.update.mockRejectedValue(new Error('storage unavailable'));
    const api = useLauncherSettings();
    await api.update({ visibility: 'show' });
    expect(api.unimplementedLauncherEntries.value).toBe('hide');
    expect(api.saving.value).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Could not save the display settings. Try again.' });
  });

  it('does not report an old storage failure in a replacement storage', async () => {
    mocks.capture.mockReturnValue(() => false);
    mocks.update.mockRejectedValue(new Error('old storage unavailable'));
    await useLauncherSettings().update({ visibility: 'show' });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });
});
