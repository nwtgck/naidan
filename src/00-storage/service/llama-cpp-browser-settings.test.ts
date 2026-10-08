import { beforeEach, describe, expect, it } from 'vitest';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type LlamaCppBrowserSettings, type Settings } from '@/01-models/types';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { LocalStorageProvider } from './local-storage';

const settingsKey = `${STORAGE_KEY_PREFIX}lsp:settings`;

describe('persisted llama.cpp browser destination preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each<NonNullable<LlamaCppBrowserSettings['modelDownloadDestination']>>([
    { kind: 'opfs' },
    { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'lm-model-directory' }) },
  ])('preserves the selected destination and unrelated image settings after provider recreation: %j', async modelDownloadDestination => {
    const imageDirectoryId = toHostModelDirectoryId({ raw: 'image-model-directory' });
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      endpoint: { type: 'llama_cpp_browser' },
      storageType: 'local',
      experimental: {
        locale: 'ja',
        llamaCppBrowser: { modelDownloadDestination },
        browserImageGeneration: {
          modelDownloadDestination: { kind: 'host', directoryId: imageDirectoryId },
          width: 512,
          height: 768,
          debug: 'on',
        },
        hostModelDirectories: [
          { id: toHostModelDirectoryId({ raw: 'lm-model-directory' }), name: 'language models' },
          { id: imageDirectoryId, name: 'image models' },
        ],
      },
    };
    const provider = new LocalStorageProvider();

    await provider.saveSettings({ settings });
    const raw = localStorage.getItem(settingsKey);

    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).experimental.llamaCppBrowser).toStrictEqual({ modelDownloadDestination });

    const reopenedProvider = new LocalStorageProvider();
    const restored = await reopenedProvider.loadSettings();

    expect(restored).not.toBeNull();
    expect(restored?.experimental?.llamaCppBrowser).toStrictEqual({ modelDownloadDestination });
    expect(restored?.experimental?.browserImageGeneration).toMatchObject(settings.experimental!.browserImageGeneration!);
    expect(restored?.experimental?.hostModelDirectories).toStrictEqual(settings.experimental!.hostModelDirectories);
    expect(restored?.experimental?.locale).toBe('ja');

    await reopenedProvider.saveSettings({ settings: restored! });

    expect(localStorage.getItem(settingsKey)).toBe(raw);
  });
});
