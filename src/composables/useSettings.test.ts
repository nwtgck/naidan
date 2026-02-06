import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettings } from './useSettings';
import { DEFAULT_SETTINGS } from '../models/types';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';
import { flushPromises } from '@vue/test-utils';

const { mockAddErrorEvent, mockListModels } = vi.hoisted(() => ({
  mockAddErrorEvent: vi.fn(),
  mockListModels: vi.fn().mockResolvedValue(['model-1', 'model-2']),
}));

vi.mock('./useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
  }),
}));

// Mock storageService using vi.hoisted for the implementation
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  loadSettings: vi.fn(),
  updateSettings: vi.fn().mockImplementation(async (updater) => {
    const current = await mocks.loadSettings();
    return await updater(current);
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

vi.mock('../services/llm', () => ({
  OpenAIProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
  OllamaProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
}));

describe('useSettings Initialization and Bootstrap', () => {
  const { __testOnly: { __testOnlyReset } } = useSettings();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    __testOnlyReset();
    mocks.loadSettings.mockResolvedValue(null);
  });

  it('should initialize StorageService with correct type from bootstrap key', async () => {
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'opfs');
    const { init } = useSettings();
    await init();
    expect(mocks.init).toHaveBeenCalledWith('opfs');
  });

  it('should determine, persist and pass opfs to StorageService if bootstrap key is missing (new user)', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
    
    const { init } = useSettings();
    await init();
    
    expect(mocks.init).toHaveBeenCalledWith('opfs');
    expect(localStorage.getItem(STORAGE_BOOTSTRAP_KEY)).toBe('opfs');
  });

  it('should sync settings.value.storageType with detected bootstrapType during init', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
    localStorage.clear();
    
    const { init, settings } = useSettings();
    // Before init it is local
    expect(settings.value.storageType).toBe('local');
    
    await init();
    
    // After init, it should have been updated to 'opfs' (from detection)
    expect(settings.value.storageType).toBe('opfs');
  });

  it('should preserve detected storageType when saving settings (onboarding simulation)', async () => {
    localStorage.removeItem(STORAGE_BOOTSTRAP_KEY);
    localStorage.clear();
    
    const { init, save, settings } = useSettings();
    await init(); // This detects 'opfs' and sets settings.value.storageType = 'opfs'
    
    // Simulate finishing onboarding: save new URL/Type but don't explicitly mention storageType
    // (spread of settings.value should include the detected 'opfs')
    await save({
      ...JSON.parse(JSON.stringify(settings.value)),
      endpointUrl: 'http://new-endpoint',
      endpointType: 'ollama'
    });
    
    expect(settings.value.storageType).toBe('opfs');
    expect(mocks.updateSettings).toHaveBeenCalled();
    // Verify the result of the updater (which we know in this test)
    const updater = mocks.updateSettings.mock.calls[0]![0];
    const updated = await updater();
    expect(updated).toEqual(expect.objectContaining({
      storageType: 'opfs',
      endpointUrl: 'http://new-endpoint'
    }));
  });

  it('should report error and fallback if invalid storage type is in localStorage', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'invalid-type');
    
    const { init } = useSettings();
    await init();
    
    expect(consoleSpy).toHaveBeenCalled();
    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'SettingsService',
      message: expect.stringContaining('Invalid storage type'),
    }));
    // Should fallback to detection (opfs in this mock environment)
    expect(mocks.init).toHaveBeenCalledWith('opfs');
    
    consoleSpy.mockRestore();
  });

  it('should set isOnboardingDismissed to true if endpointUrl is present in loaded settings', async () => {
    // Setup mock to return settings WITH endpointUrl
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      storageType: 'local',
      endpointUrl: 'http://localhost:11434',
      endpointType: 'openai',
    });

    // Act
    const { init, isOnboardingDismissed, settings } = useSettings();
    await init();

    // Assert
    expect(isOnboardingDismissed.value).toBe(true);
    expect(settings.value.endpointUrl).toBe('http://localhost:11434');
  });

  it('should NOT set isOnboardingDismissed to true if endpointUrl is missing', async () => {
    // Setup mock to return settings WITHOUT endpointUrl
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      endpointUrl: undefined,
    });

    // Act
    const { init, isOnboardingDismissed } = useSettings();
    await init();

    // Assert
    expect(isOnboardingDismissed.value).toBe(false);
  });

  it('should NOT set isOnboardingDismissed to true if no settings are loaded (first run)', async () => {
    // Setup mock to return null
    mocks.loadSettings.mockResolvedValue(null);

    // Act
    const { init, isOnboardingDismissed } = useSettings();
    await init();

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
    const p1 = init();
    const p2 = init();
    const p3 = init();
    
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
      await init();
      mockListModels.mockClear();

      await fetchModels();

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
      await init();
      mockListModels.mockClear();

      await fetchModels({
        url: 'http://override-url',
        type: 'ollama',
        headers: [['X-Test', 'true']],
      });

      expect(mockListModels).toHaveBeenCalledWith({});
      expect(mockListModels).toHaveBeenCalledTimes(1);
    });
  });
});