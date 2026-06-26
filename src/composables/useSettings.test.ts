import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from './useSettings';
import { DEFAULT_SETTINGS } from '@/models/types';
import { STORAGE_BOOTSTRAP_KEY } from '@/models/constants';
import { flushPromises } from '@vue/test-utils';
import { currentLocale, setLocale as setStringLocale } from '@/strings/runtime';

const { mockAddErrorEvent, mockListModels, mockShowConfirm, mockImportFromBase64, mockPreloadFakeLmLanguagePacks } = vi.hoisted(() => ({
  mockAddErrorEvent: vi.fn(),
  mockListModels: vi.fn().mockResolvedValue(['model-1', 'model-2']),
  mockShowConfirm: vi.fn(),
  mockImportFromBase64: vi.fn().mockResolvedValue(undefined),
  mockPreloadFakeLmLanguagePacks: vi.fn(),
}));

vi.mock('../services/import-export/url-logic', () => ({
  urlImportExportLogic: {
    importFromBase64: mockImportFromBase64,
  },
}));

vi.mock('@/services/fake-lm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/fake-lm')>()),
  preloadFakeLmLanguagePacks: mockPreloadFakeLmLanguagePacks,
}));

vi.mock('./useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
    addInfoEvent: vi.fn(),
  }),
}));

vi.mock('./useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

// Mock storageService using vi.hoisted for the implementation
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  loadSettings: vi.fn(),
  updateSettings: vi.fn().mockImplementation(async ({ updater }) => {
    const current = await mocks.loadSettings();
    return await updater({ current: current });
  }),
  switchProvider: vi.fn(),
  getCurrentType: vi.fn().mockReturnValue('local'),
  subscribeToChanges: vi.fn().mockReturnValue(() => {}),
  notify: vi.fn(),
}));

vi.mock('../services/storage', () => ({
  storageService: mocks,
}));

vi.mock('../services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
}));

describe('useSettings Initialization and Bootstrap', () => {
  const { TEST_ONLY: { __testOnlyReset } } = useSettings();

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    __testOnlyReset();
    mocks.loadSettings.mockResolvedValue(null);
    await setStringLocale({ locale: 'en' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the browser locale without persisting it during initialization', async () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'local');

    const { init, settings } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    expect(currentLocale.value).toBe('ja');
    expect(settings.value.experimental?.locale).toBeUndefined();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('persists an explicitly selected locale in experimental settings', async () => {
    const current = {
      ...DEFAULT_SETTINGS,
      endpointType: 'openai' as const,
      storageType: 'local' as const,
      experimental: {
        fakeLm: 'disabled' as const,
      },
    };
    mocks.loadSettings.mockResolvedValue(current);
    const { setLocale, settings, TEST_ONLY: { __testOnlySetSettings } } = useSettings();
    __testOnlySetSettings({ newSettings: current });

    await setLocale({ locale: 'ja' });

    expect(settings.value.experimental).toEqual({
      fakeLm: 'disabled',
      locale: 'ja',
    });
    expect(currentLocale.value).toBe('ja');
  });

  it('keeps the current locale unchanged when persistence fails', async () => {
    const current = {
      ...DEFAULT_SETTINGS,
      endpointType: 'openai' as const,
      storageType: 'local' as const,
      experimental: {
        fakeLm: 'disabled' as const,
      },
    };
    mocks.loadSettings.mockResolvedValue(current);
    mocks.updateSettings.mockRejectedValueOnce(new Error('Failed to persist settings'));
    const { setLocale, settings, TEST_ONLY: { __testOnlySetSettings } } = useSettings();
    __testOnlySetSettings({ newSettings: current });

    await expect(setLocale({ locale: 'ja' })).rejects.toThrow('Failed to persist settings');

    expect(currentLocale.value).toBe('en');
    expect(settings.value.experimental?.locale).toBeUndefined();
  });

  it('should initialize StorageService with correct type from bootstrap key', async () => {
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'opfs');
    const { init } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });
    expect(mocks.init).toHaveBeenCalledWith({ type: 'opfs' });
  });

  it('should determine, persist and pass opfs to StorageService if bootstrap key is missing (new user)', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);

    const { init } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    expect(mocks.init).toHaveBeenCalledWith({ type: 'opfs' });
    expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('opfs');
  });

  it('should sync settings.value.storageType with detected bootstrapType during init', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
    localStorage.clear();

    const { init, settings } = useSettings();
    // Before init it is local
    expect(settings.value.storageType).toBe('local');

    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    // After init, it should have been updated to 'opfs' (from detection)
    expect(settings.value.storageType).toBe('opfs');
  });

  it('should preserve detected storageType when saving settings (onboarding simulation)', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
    localStorage.clear();

    const { init, save, settings } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined }); // This detects 'opfs' and sets settings.value.storageType = 'opfs'

    // Simulate finishing onboarding: save new URL/Type but don't explicitly mention storageType
    // (spread of settings.value should include the detected 'opfs')
    await save({ patch: {
      ...JSON.parse(JSON.stringify(settings.value)),
      endpointUrl: 'http://new-endpoint',
      endpointType: 'ollama',
    } });

    expect(settings.value.storageType).toBe('opfs');
    expect(mocks.updateSettings).toHaveBeenCalled();
    // Verify the result of the updater (which we know in this test)
    const updater = mocks.updateSettings.mock.calls[0]![0].updater;
    const updated = await updater({ current: settings.value });
    expect(updated).toEqual(expect.objectContaining({
      storageType: 'opfs',
      endpointUrl: 'http://new-endpoint',
    }));
  });

  it('updates one experimental field against the latest persisted settings', async () => {
    const local = {
      ...DEFAULT_SETTINGS,
      endpointType: 'openai' as const,
      storageType: 'local' as const,
      experimental: {
        toolConfigPersistence: 'enabled' as const,
      },
    };
    const persisted = {
      ...local,
      experimental: {
        ...local.experimental,
        fakeLm: 'enabled' as const,
      },
    };
    mocks.loadSettings.mockResolvedValue(persisted);
    const { updateExperimental, settings, TEST_ONLY: { __testOnlySetSettings } } = useSettings();
    __testOnlySetSettings({ newSettings: local });

    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
      }),
    });

    expect(settings.value.experimental).toEqual({
      toolConfigPersistence: 'enabled',
      fakeLm: 'enabled',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    });
  });

  it('persists fake LM mode without overwriting other experimental settings', async () => {
    const current = {
      ...DEFAULT_SETTINGS,
      endpointType: 'openai' as const,
      storageType: 'local' as const,
      experimental: {
        toolConfigPersistence: 'enabled' as const,
        sidebarSendMessageReorder: 'move_sent_chat' as const,
        fakeLm: 'disabled' as const,
      },
    };
    mocks.loadSettings.mockResolvedValue(current);
    const { setFakeLmDebugModeStatus, settings, TEST_ONLY: { __testOnlySetSettings } } = useSettings();
    __testOnlySetSettings({ newSettings: current });

    await setFakeLmDebugModeStatus({ status: 'enabled' });

    expect(settings.value.experimental).toEqual({
      toolConfigPersistence: 'enabled',
      sidebarSendMessageReorder: 'move_sent_chat',
      fakeLm: 'enabled',
    });
    const updater = mocks.updateSettings.mock.calls[0]![0].updater;
    const updated = await updater({ current });
    expect(updated).toEqual(expect.objectContaining({
      experimental: {
        toolConfigPersistence: 'enabled',
        sidebarSendMessageReorder: 'move_sent_chat',
        fakeLm: 'enabled',
      },
    }));
    expect(mockPreloadFakeLmLanguagePacks).toHaveBeenCalledOnce();
  });

  it('preloads fake LM language data when persisted mode is enabled during initialization', async () => {
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'local');
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      endpointType: 'openai',
      storageType: 'local',
      experimental: {
        fakeLm: 'enabled',
      },
    });

    const { init } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    expect(mockPreloadFakeLmLanguagePacks).toHaveBeenCalledOnce();
  });

  it('should report error and fallback if invalid storage type is in localStorage', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'invalid-type');

    const { init } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    expect(consoleSpy).toHaveBeenCalled();
    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'SettingsService',
      message: expect.stringContaining('Invalid storage type'),
    }));
    // Should fallback to detection (opfs in this mock environment)
    expect(mocks.init).toHaveBeenCalledWith({ type: 'opfs' });

    consoleSpy.mockRestore();
  });

  describe('Storage Type Query Parameter', () => {
    it('should use storage-type from override if not already initialized', async () => {
      localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);

      const { init } = useSettings();
      await init({ storageTypeOverride: 'memory', dataZipBase64: undefined });

      expect(mocks.init).toHaveBeenCalledWith({ type: 'memory' });
      expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('memory');
    });

    it('should ignore storage-type from override if already initialized and show confirm', async () => {
      localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'local');

      const { init } = useSettings();
      await init({ storageTypeOverride: 'memory', dataZipBase64: undefined });

      expect(mocks.init).toHaveBeenCalledWith({ type: 'local' });
      expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('local');
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Storage Already Initialized',
      }));
    });

    it('should NOT show confirm if storage-type from override matches already initialized type', async () => {
      localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'local');

      const { init } = useSettings();
      await init({ storageTypeOverride: 'local', dataZipBase64: undefined });

      expect(mocks.init).toHaveBeenCalledWith({ type: 'local' });
      expect(mockShowConfirm).not.toHaveBeenCalled();
    });

    it('should ignore invalid storage-type from override', async () => {
      localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);

      const { init } = useSettings();
      await init({ storageTypeOverride: 'invalid', dataZipBase64: undefined });

      // Should fallback to detection (opfs in this mock environment)
      expect(mocks.init).toHaveBeenCalledWith({ type: 'opfs' });
      expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('opfs');
    });

    it('should successfully initialize with "memory" when provided as a string override (simulating router query param)', async () => {
      // This mimics the flow in main.ts:
      // const storageTypeOverride = router.currentRoute.value.query['storage-type'];
      // await settingsStore.init({ storageTypeOverride });

      localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
      const { init } = useSettings();

      await init({ storageTypeOverride: 'memory', dataZipBase64: undefined });

      expect(mocks.init).toHaveBeenCalledWith({ type: 'memory' });
      expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('memory');
    });

    it('should import data from dataZipBase64 during init', async () => {
      const { init } = useSettings();
      await init({ storageTypeOverride: undefined, dataZipBase64: 'mock-base64-data' });

      expect(mockImportFromBase64).toHaveBeenCalledWith({ zipBase64: 'mock-base64-data' });
    });
  });

  it('should set isOnboardingDismissed to true if endpointUrl AND defaultModelId are present in loaded settings', async () => {
    // Setup mock to return settings WITH endpointUrl and defaultModelId
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      storageType: 'local',
      endpointUrl: 'http://localhost:11434',
      endpointType: 'openai',
      defaultModelId: 'gpt-3.5',
    });

    // Act
    const { init, isOnboardingDismissed, settings } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    // Assert
    expect(isOnboardingDismissed.value).toBe(true);
    expect(settings.value.endpointUrl).toBe('http://localhost:11434');
  });

  it('should NOT set isOnboardingDismissed to true if endpointUrl is present but defaultModelId is missing', async () => {
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      storageType: 'local',
      endpointUrl: 'http://localhost:11434',
      endpointType: 'openai',
      defaultModelId: undefined,
    });

    const { init, isOnboardingDismissed } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    expect(isOnboardingDismissed.value).toBe(false);
  });

  it('should NOT set isOnboardingDismissed to true if endpointUrl is missing', async () => {
    // Setup mock to return settings WITHOUT endpointUrl
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      endpointUrl: undefined,
    });

    // Act
    const { init, isOnboardingDismissed } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    // Assert
    expect(isOnboardingDismissed.value).toBe(false);
  });

  it('should NOT set isOnboardingDismissed to true if no settings are loaded (first run)', async () => {
    // Setup mock to return null
    mocks.loadSettings.mockResolvedValue(null);

    // Act
    const { init, isOnboardingDismissed } = useSettings();
    await init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    // Assert
    expect(isOnboardingDismissed.value).toBe(false);
  });

  it('should handle parallel init calls correctly using the promise guard', async () => {
    let resolveStorageInit: (value: void | PromiseLike<void>) => void;
    const storageInitPromise = new Promise<void>((resolve) => {
      resolveStorageInit = resolve;
    });

    // Make storageService.init hang until we manually resolve it
    mocks.init.mockReturnValue(storageInitPromise);

    const { init, initialized } = useSettings();

    // Trigger multiple calls in parallel
    const p1 = init({ storageTypeOverride: undefined, dataZipBase64: undefined });
    const p2 = init({ storageTypeOverride: undefined, dataZipBase64: undefined });
    const p3 = init({ storageTypeOverride: undefined, dataZipBase64: undefined });

    // Wait for microtasks (like checkOPFSSupport) to settle
    await flushPromises();

    // Verify storageService.init was only called once despite multiple calls to init()
    expect(mocks.init).toHaveBeenCalledTimes(1);

    // Resolve the first call
    resolveStorageInit!();

    await Promise.all([p1, p2, p3]);

    expect(initialized.value).toBe(true);
  });

  describe('fetchModels', () => {
    it('should use saved settings when no overrides are provided', async () => {
      mocks.loadSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        storageType: 'local',
        endpointUrl: 'http://saved-url',
        endpointType: 'openai',
      });

      const { init, fetchModels } = useSettings();
      await init({ storageTypeOverride: undefined, dataZipBase64: undefined });
      mockListModels.mockClear();

      await fetchModels({});

      expect(mockListModels).toHaveBeenCalledWith({});
    });

    it('should use provided overrides instead of saved settings', async () => {
      mocks.loadSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        storageType: 'local',
        endpointUrl: 'http://saved-url',
        endpointType: 'openai',
      });

      const { init, fetchModels } = useSettings();
      await init({ storageTypeOverride: undefined, dataZipBase64: undefined });
      mockListModels.mockClear();

      await fetchModels({ overrides: {
        url: 'http://override-url',
        type: 'ollama',
        headers: [['X-Test', 'true']],
      } });

      expect(mockListModels).toHaveBeenCalledWith({});
      expect(mockListModels).toHaveBeenCalledTimes(1);
    });
  });

  describe('Explicit Actions and Onboarding Dismissal', () => {
    const { TEST_ONLY: { __testOnlyReset } } = useSettings();

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      __testOnlyReset();
    });

    it('should set isOnboardingDismissed to true when BOTH endpoint and model are set', async () => {
      const { updateGlobalEndpoint, updateGlobalModel, isOnboardingDismissed } = useSettings();

      expect(isOnboardingDismissed.value).toBe(false);

      await updateGlobalEndpoint({
        type: 'ollama',
        url: 'http://localhost:11434',
      });

      // Still false because model is missing
      expect(isOnboardingDismissed.value).toBe(false);

      await updateGlobalModel({ modelId: 'test-model' });

      // Now true because both are present
      expect(isOnboardingDismissed.value).toBe(true);
    });
  });
});
