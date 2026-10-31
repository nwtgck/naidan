import { shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';
import { useLiveModelPreference } from './useLiveModelPreference';

type Update = ReturnType<typeof useSettings>['updateExperimentalForStorage'];
const settings = shallowRef<Pick<Settings, 'experimental'>>({ experimental: undefined });
let generation = 0;
const update = vi.fn<Update>(async ({ isCurrent, updater }) => {
  if (!isCurrent()) {
    return 'changed';
  }
  settings.value = { experimental: updater({ experimental: settings.value.experimental }) };
  return 'saved';
});
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    captureExperimentalStorage: () => {
      const current = generation;
      return () => current === generation;
    },
    updateExperimentalForStorage: update,
  }),
}));

beforeEach(() => {
  generation = 0;
  settings.value = { experimental: undefined };
  update.mockClear();
});

describe('minimal live model preference persistence', () => {
  it('does not write on mount, and saves only modelId alongside existing experimental fields', async () => {
    settings.value = { experimental: { toolConfigPersistence: 'enabled', fakeLm: 'disabled', sidebarSendMessageReorder: 'disabled', liveConversationModelId: 'previous' } };
    const pref = useLiveModelPreference();
    expect(pref.remembered.value).toBe('previous');
    expect(update).not.toHaveBeenCalled();
    await pref.remember({ modelId: 'selected' });
    expect(settings.value.experimental).toEqual({ toolConfigPersistence: 'enabled', fakeLm: 'disabled', sidebarSendMessageReorder: 'disabled', liveConversationModelId: 'selected' });
    expect(pref.remembered.value).toBe('selected');
  });

  it('serializes quick changes, including a clearing selection', async () => {
    const pref = useLiveModelPreference();
    const first = pref.remember({ modelId: 'one' });
    const second = pref.remember({ modelId: 'two' });
    await first;
    await second;
    expect(pref.remembered.value).toBe('two');
    await pref.remember({ modelId: '' });
    expect(pref.remembered.value).toBeUndefined();
  });

  it('does not carry a delayed write across a storage change', async () => {
    const pref = useLiveModelPreference();
    const writing = pref.remember({ modelId: 'old storage model' });
    generation++;
    await writing;
    expect(settings.value.experimental).toBeUndefined();
  });

  it('allows a new selection after a storage write fails', async () => {
    const pref = useLiveModelPreference();
    update.mockRejectedValueOnce(new Error('quota'));
    await expect(pref.remember({ modelId: 'failed' })).rejects.toThrow('quota');
    await pref.remember({ modelId: 'works' });
    expect(pref.remembered.value).toBe('works');
  });
});
