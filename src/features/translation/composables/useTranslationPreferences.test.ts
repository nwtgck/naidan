import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { useSettings } from '@/composables/useSettings';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { useTranslationPreferences } from './useTranslationPreferences';

function fixture() {
  const scope = effectScope();
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'local', experimental: { locale: 'ja', translation: { modelId: 'original', autoTranslate: { enabled: true } } } });
  let generation = 0;
  const captureExperimentalStorage = () => {
    const accepted = generation;
    return () => accepted === generation;
  };
  const updateExperimentalForStorage = vi.fn<ReturnType<typeof useSettings>['updateExperimentalForStorage']>().mockImplementation(async ({ isCurrent, updater }) => {
    if (!isCurrent()) {
      return 'changed';
    }
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  const store = { settings, captureExperimentalStorage, updateExperimentalForStorage };
  const state = scope.run(() => useTranslationPreferences({ store }))!;
  return {
    state,
    store,
    scope,
    switchStorage() {
      generation++;
      settings.value = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'memory' };
    },
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

describe('translation preferences', () => {
  it('saves only requested preferences and preserves unrelated settings and the chat default', async () => {
    using f = fixture();
    const chatModel = f.store.settings.value.defaultModelId;
    expect(await f.state.save({ patch: { autoTranslate: { enabled: false } } })).toBe(true);
    expect(f.store.settings.value.experimental).toEqual({ locale: 'ja', translation: { modelId: 'original', autoTranslate: { enabled: false } } });
    expect(f.store.settings.value.defaultModelId).toBe(chatModel);
  });

  it('allows the automatic translation preference to return to its default', async () => {
    using f = fixture();
    await f.state.save({ patch: { autoTranslate: undefined } });
    expect(f.state.preferences.value?.autoTranslate).toBeUndefined();
    expect(JSON.stringify(f.state.preferences.value)).not.toContain('autoTranslate');
  });

  it('does not race optimistic selections or admit a second write while saving', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<void>();
    f.store.updateExperimentalForStorage.mockImplementationOnce(async ({ isCurrent, updater }) => {
      await pending.promise;
      if (!isCurrent()) {
        return 'changed';
      }
      f.store.settings.value.experimental = updater({ experimental: f.store.settings.value.experimental });
      return 'saved';
    });
    const first = f.state.save({ patch: { autoTranslate: { enabled: false } } });
    expect(f.state.saving.value).toBe(true);
    expect(f.state.preferences.value?.autoTranslate).toEqual({ enabled: true });
    expect(await f.state.save({ patch: { autoTranslate: { enabled: false } } })).toBe(false);
    pending.resolve();
    expect(await first).toBe(true);
    expect(f.state.preferences.value?.autoTranslate).toEqual({ enabled: false });
  });

  it('does not apply a delayed update to a replacement storage', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<void>();
    f.store.updateExperimentalForStorage.mockImplementationOnce(async ({ isCurrent, updater }) => {
      await pending.promise;
      if (!isCurrent()) {
        return 'changed';
      }
      f.store.settings.value.experimental = updater({ experimental: f.store.settings.value.experimental });
      return 'saved';
    });
    const saving = f.state.save({ patch: { modelId: 'old-storage-model' } });
    f.switchStorage();
    pending.resolve();
    expect(await saving).toBe(false);
    expect(f.state.preferences.value).toBeUndefined();
    expect(f.state.failed.value).toBe(false);
  });

  it('retains the previous selection after a failed save and permits retry', async () => {
    using f = fixture();
    f.store.updateExperimentalForStorage.mockRejectedValueOnce(new Error('full'));
    expect(await f.state.save({ patch: { autoTranslate: { enabled: false } } })).toBe(false);
    expect(f.state.failed.value).toBe(true);
    expect(f.state.preferences.value?.autoTranslate).toEqual({ enabled: true });
    expect(await f.state.save({ patch: { autoTranslate: { enabled: false } } })).toBe(true);
    expect(f.state.failed.value).toBe(false);
  });

  it('does not save after scope disposal', async () => {
    using f = fixture();
    f.scope.stop();
    expect(await f.state.save({ patch: { autoTranslate: { enabled: false } } })).toBe(false);
    expect(f.store.updateExperimentalForStorage).not.toHaveBeenCalled();
  });
});
