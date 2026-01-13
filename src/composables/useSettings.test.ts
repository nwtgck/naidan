import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettings } from './useSettings';
import { DEFAULT_SETTINGS } from '../models/types';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';

// Mock storageService using vi.hoisted for the implementation
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  switchProvider: vi.fn(),
  getCurrentType: vi.fn().mockReturnValue('local'),
}));

vi.mock('../services/storage', () => ({
  storageService: mocks,
}));

describe('useSettings Initialization and Bootstrap', () => {
  // Access refs to reset them
  const { initialized, isOnboardingDismissed, settings } = useSettings();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Reset shared state
    initialized.value = false;
    isOnboardingDismissed.value = false;
    settings.value = { ...DEFAULT_SETTINGS };
  });

  it('should initialize StorageService with correct type from bootstrap key', async () => {
    localStorage.setItem(STORAGE_BOOTSTRAP_KEY, 'opfs');
    const { init } = useSettings();
    await init();
    expect(mocks.init).toHaveBeenCalledWith('opfs');
  });

  it('should default to local storage if bootstrap key is missing', async () => {
    const { init } = useSettings();
    await init();
    expect(mocks.init).toHaveBeenCalledWith('local');
  });

  it('should set isOnboardingDismissed to true if endpointUrl is present in loaded settings', async () => {
    // Setup mock to return settings WITH endpointUrl
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      endpointUrl: 'http://localhost:11434',
    });

    // Act
    const { init } = useSettings();
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
    const { init } = useSettings();
    await init();

    // Assert
    expect(isOnboardingDismissed.value).toBe(false);
  });

  it('should NOT set isOnboardingDismissed to true if no settings are loaded (first run)', async () => {
    // Setup mock to return null
    mocks.loadSettings.mockResolvedValue(null);

    // Act
    const { init } = useSettings();
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
    
    const { init } = useSettings();
        
    // Trigger multiple calls in parallel
    const p1 = init();
    const p2 = init();
    const p3 = init();
    
    // Verify storageService.init was only called once despite multiple calls to init()
    expect(mocks.init).toHaveBeenCalledTimes(1);
    
    // Resolve the first call
    resolveStorageInit!();
        
    await Promise.all([p1, p2, p3]);
        
    expect(initialized.value).toBe(true);
  });
});