import { ref, readonly } from 'vue';
import { type Settings, type EndpointType, DEFAULT_SETTINGS, type StorageType } from '../models/types';
import { storageService } from '../services/storage';
import { checkOPFSSupport } from '../services/storage/opfs-detection';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { StorageTypeSchemaDto } from '../models/dto';
import { useGlobalEvents } from './useGlobalEvents';

const _settings = ref<Settings>({ 
  ...DEFAULT_SETTINGS, 
  storageType: 'local',
  endpointType: 'openai'
} as Settings);

const _initialized = ref(false);
const _isOnboardingDismissed = ref(false);
const _onboardingDraft = ref<{ url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null>(null);
const availableModels = ref<string[]>([]);
const isFetchingModels = ref(false);

let initPromise: Promise<void> | null = null;

// --- Synchronization ---

storageService.subscribeToChanges(async (event) => {
  if (event.type === 'settings' || event.type === 'migration') {
    const fresh = await storageService.loadSettings();
    if (fresh) {
      _settings.value = fresh;
    }
  }
});

export function useSettings() {
  const loading = ref(false);

  async function init() {
    if (_initialized.value) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      loading.value = true;
      try {
        // Determine storage type from persisted flag
        const rawSavedType = typeof localStorage !== 'undefined' 
          ? localStorage.getItem(STORAGE_BOOTSTRAP_KEY)
          : null;
        
        const validatedType = StorageTypeSchemaDto.safeParse(rawSavedType);
        let bootstrapType: 'local' | 'opfs' | null = validatedType.success ? validatedType.data : null;

        if (rawSavedType !== null && !validatedType.success) {
          console.warn(`Invalid storage type found in localStorage: "${rawSavedType}". Falling back to detection.`, validatedType.error);
          const { addErrorEvent } = useGlobalEvents();
          addErrorEvent({
            source: 'SettingsService',
            message: 'Invalid storage type found in localStorage. Falling back to default detection.',
            details: validatedType.error,
          });
        }

        if (!bootstrapType) {
          // First run or cleared state: detect best available storage
          const isSupported = await checkOPFSSupport();
          bootstrapType = isSupported ? 'opfs' : 'local';
          
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, bootstrapType);
          }
        }

        // Sync local settings ref with determined storage type
        _settings.value.storageType = bootstrapType;

        await storageService.init(bootstrapType);
        const s = await storageService.loadSettings();
        if (s) {
          _settings.value = s;
          if (s.endpointUrl) {
            _isOnboardingDismissed.value = true;
            // Initial fetch of models if we have an endpoint
            fetchModels();
          }
        } else {
          // If no settings saved yet (new user), ensure defaults are clean but functional
          _settings.value.endpointType = 'openai';
        }
      } finally {
        loading.value = false;
        _initialized.value = true;
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function fetchModels() {
    if (!_settings.value.endpointUrl) {
      availableModels.value = [];
      return;
    }
    isFetchingModels.value = true;
    try {
      const provider = _settings.value.endpointType === 'ollama' 
        ? new OllamaProvider() 
        : new OpenAIProvider();
      
      const mutableHeaders = _settings.value.endpointHttpHeaders ? JSON.parse(JSON.stringify(_settings.value.endpointHttpHeaders)) : undefined;
      const models = await provider.listModels(_settings.value.endpointUrl, mutableHeaders);
      availableModels.value = models;
    } catch (err) {
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({
        source: 'useSettings:fetchModels',
        message: 'Failed to fetch models for settings',
        details: err instanceof Error ? err : String(err),
      });
      console.error('Failed to fetch models:', err);
    } finally {
      isFetchingModels.value = false;
    }
  }

  async function save(newSettings: Settings) {
    const oldUrl = _settings.value.endpointUrl;
    const oldType = _settings.value.endpointType;
    
    _settings.value = { ...newSettings };
    
    const currentProviderType = storageService.getCurrentType();
    if (newSettings.storageType !== currentProviderType) {
      await storageService.switchProvider(newSettings.storageType);
    }
    
    await storageService.updateSettings(() => _settings.value);

    if (newSettings.endpointUrl !== oldUrl || newSettings.endpointType !== oldType) {
      await fetchModels();
    }
  }

  // --- Explicit Actions ---

  async function updateGlobalModel(modelId: string) {
    _settings.value.defaultModelId = modelId;
    await storageService.updateSettings((curr) => ({ ...curr, ..._settings.value, defaultModelId: modelId }));
  }

  async function updateGlobalEndpoint(options: { type: EndpointType, url: string, headers?: [string, string][] }) {
    const oldUrl = _settings.value.endpointUrl;
    const oldType = _settings.value.endpointType;

    _settings.value.endpointType = options.type;
    _settings.value.endpointUrl = options.url;
    _settings.value.endpointHttpHeaders = options.headers;

    await storageService.updateSettings((curr) => ({ 
      ...curr, 
      ..._settings.value,
      endpointType: options.type,
      endpointUrl: options.url,
      endpointHttpHeaders: options.headers
    }));

    if (options.url !== oldUrl || options.type !== oldType) {
      await fetchModels();
    }
  }

  async function updateSystemPrompt(prompt: string) {
    _settings.value.systemPrompt = prompt;
    await storageService.updateSettings((curr) => ({ ...curr, ..._settings.value, systemPrompt: prompt }));
  }

  async function updateStorageType(type: StorageType) {
    if (_settings.value.storageType === type) return;
    
    _settings.value.storageType = type;
    await storageService.switchProvider(type);
    await storageService.updateSettings((curr) => ({ ...curr, ..._settings.value, storageType: type }));
  }

  function setIsOnboardingDismissed(dismissed: boolean) {
    _isOnboardingDismissed.value = dismissed;
  }

  function setOnboardingDraft(draft: { url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null) {
    _onboardingDraft.value = draft;
  }

  function setHeavyContentAlertDismissed(dismissed: boolean) {
    _settings.value.heavyContentAlertDismissed = dismissed;
    storageService.updateSettings((curr) => ({ ...curr, ..._settings.value, heavyContentAlertDismissed: dismissed }));
  }

  function __testOnlySetSettings(newSettings: Settings) {
    _settings.value = JSON.parse(JSON.stringify(newSettings));
  }

  function __testOnlyReset() {
    _initialized.value = false;
    _isOnboardingDismissed.value = false;
    _onboardingDraft.value = null;
    _settings.value = { 
      ...DEFAULT_SETTINGS, 
      storageType: 'local',
      endpointType: 'openai'
    } as Settings;
    availableModels.value = [];
    isFetchingModels.value = false;
    initPromise = null;
  }

  return {
    settings: readonly(_settings),
    initialized: readonly(_initialized),
    isOnboardingDismissed: readonly(_isOnboardingDismissed),
    onboardingDraft: readonly(_onboardingDraft),
    availableModels: readonly(availableModels),
    isFetchingModels: readonly(isFetchingModels),
    init,
    save,
    fetchModels,
    updateGlobalModel,
    updateGlobalEndpoint,
    updateSystemPrompt,
    updateStorageType,
    setIsOnboardingDismissed,
    setOnboardingDraft,
    setHeavyContentAlertDismissed,
    __testOnlyReset,
    __testOnlySetSettings
  };
}
