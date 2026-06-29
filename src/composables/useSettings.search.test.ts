import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';

const storageMocks = vi.hoisted(() => ({
  updateSettings: vi.fn(async ({ updater }: {
    updater: ({ current }: { current: Settings | undefined }) => Settings,
  }) => updater({ current: undefined })),
  subscribeToChanges: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../00-storage/service', () => ({
  storageService: storageMocks,
}));

import { useSettings } from './useSettings';

describe('useSettings - Global Search settings', () => {
  const {
    globalSearchScope,
    globalSearchRoleFilter,
    searchPreviewMode,
    searchContextSize,
    setGlobalSearchScope,
    setGlobalSearchRoleFilter,
    setSearchPreviewMode,
    setSearchContextSize,
    settings,
    TEST_ONLY: {
      __testOnlyReset,
      __testOnlySetSettings,
    },
  } = useSettings();

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnlyReset();
  });

  it('uses the existing defaults when no settings have been persisted', () => {
    expect(globalSearchScope.value).toBe('title_only');
    expect(globalSearchRoleFilter.value).toBe('all');
    expect(searchPreviewMode.value).toBe('always');
    expect(searchContextSize.value).toBe(2);
  });

  it('reads persisted Global Search settings', () => {
    __testOnlySetSettings({
      newSettings: {
        ...DEFAULT_SETTINGS,
        endpoint: { type: 'openai', url: '' },
        storageType: 'local',
        experimental: {
          globalSearch: {
            scope: 'all',
            roleFilter: 'assistant',
            previewMode: 'peek',
            previewContextSize: 'full',
          },
        },
      },
    });

    expect(globalSearchScope.value).toBe('all');
    expect(globalSearchRoleFilter.value).toBe('assistant');
    expect(searchPreviewMode.value).toBe('peek');
    expect(searchContextSize.value).toBe('full');
  });

  it('persists each setting without replacing other experimental values', async () => {
    __testOnlySetSettings({
      newSettings: {
        ...DEFAULT_SETTINGS,
        endpoint: { type: 'openai', url: '' },
        storageType: 'local',
        experimental: {
          locale: 'ja',
          globalSearch: {
            scope: 'title_only',
            roleFilter: 'all',
            previewMode: 'always',
            previewContextSize: 2,
          },
        },
      },
    });

    await setGlobalSearchScope({ scope: 'current_thread' });
    await setGlobalSearchRoleFilter({ roleFilter: 'user' });
    await setSearchPreviewMode({ mode: 'disabled' });
    await setSearchContextSize({ size: 4 });

    expect(settings.value.experimental).toEqual({
      locale: 'ja',
      globalSearch: {
        scope: 'current_thread',
        roleFilter: 'user',
        previewMode: 'disabled',
        previewContextSize: 4,
      },
    });
    expect(storageMocks.updateSettings).toHaveBeenCalledTimes(4);
  });

  it('persists the full-context marker without using Infinity', async () => {
    await setSearchContextSize({ size: 'full' });

    expect(searchContextSize.value).toBe('full');
    expect(settings.value.experimental?.globalSearch?.previewContextSize).toBe('full');
  });
});
