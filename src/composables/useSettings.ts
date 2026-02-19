import { ref, readonly, computed } from 'vue';
import { type Settings, type EndpointType, DEFAULT_SETTINGS, type StorageType, type ProviderProfile } from '../models/types';
import { storageService } from '../services/storage';
import { checkOPFSSupport } from '../services/storage/opfs-detection';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';
import { OpenAIProvider, OllamaProvider, type LLMProvider } from '../services/llm';
import { TransformersJsProvider } from '../services/transformers-js-provider';
import { transformersJsService } from '../services/transformers-js';
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

export type SearchPreviewMode = 'always' | 'disabled' | 'peek';
const _searchPreviewMode = ref<SearchPreviewMode>('always');
const _searchContextSize = ref(2);

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

transformersJsService.subscribeModelList(async () => {
  const type = _settings.value.endpointType;
  switch (type) {
  case 'transformers_js': {
    const { fetchModels } = useSettings();
    await fetchModels();
    break;
  }
  case 'openai':
  case 'ollama':
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
});

export function useSettings() {
  const loading = ref(false);

  const isOnboardingDismissed = computed(() => {
    const hasEndpoint = !!_settings.value.endpointUrl || _settings.value.endpointType === 'transformers_js';
    const hasModel = !!_settings.value.defaultModelId;
    return _isOnboardingDismissed.value || (hasEndpoint && hasModel);
  });

  async function init() {
    if (_initialized.value) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      loading.value = true;
      try {
        // Determine storage type from persisted flag
        const rawSavedType = (() => {
          const t = typeof localStorage;
          switch (t) {
          case 'undefined': return null;
          case 'object':
          case 'boolean':
          case 'string':
          case 'number':
          case 'function':
          case 'symbol':
          case 'bigint':
            return localStorage.getItem(STORAGE_BOOTSTRAP_KEY);
          default: {
            const _ex: never = t;
            return _ex;
          }
          }
        })();

        const validatedType = StorageTypeSchemaDto.safeParse(rawSavedType);
        let bootstrapType: 'local' | 'opfs' | 'memory' | null = validatedType.success ? validatedType.data : null;

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

          if ((() => {
            const t = typeof localStorage;
            switch (t) {
            case 'undefined': return false;
            case 'object':
            case 'boolean':
            case 'string':
            case 'number':
            case 'function':
            case 'symbol':
            case 'bigint':
              return true;
            default: {
              const _ex: never = t;
              return _ex;
            }
            }
          })()) {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, bootstrapType);
          }
        }

        // Sync local settings ref with determined storage type
        _settings.value.storageType = bootstrapType;

        await storageService.init(bootstrapType);
        const s = await storageService.loadSettings();
        if (s) {
          _settings.value = s;
          if (s.endpointUrl || s.endpointType === 'transformers_js') {
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

  async function fetchModels(overrides?: { url: string; type: EndpointType; headers?: [string, string][] }): Promise<string[]> {
    const url = overrides?.url ?? _settings.value.endpointUrl;
    const type = overrides?.type ?? _settings.value.endpointType;
    const headers = overrides?.headers ?? _settings.value.endpointHttpHeaders;

    if (!url && type !== 'transformers_js') {
      availableModels.value = [];
      return [];
    }
    isFetchingModels.value = true;
    try {
      const mutableHeaders = headers ? JSON.parse(JSON.stringify(headers)) : undefined;
      let provider: LLMProvider;
      switch (type) {
      case 'openai':
        provider = new OpenAIProvider({ endpoint: url || '', headers: mutableHeaders });
        break;
      case 'ollama':
        provider = new OllamaProvider({ endpoint: url || '', headers: mutableHeaders });
        break;
      case 'transformers_js':
        provider = new TransformersJsProvider();
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unsupported endpoint type: ${_ex}`);
      }
      }

      const models = await provider.listModels({});
      availableModels.value = models;
      return models;
    } catch (err) {
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({
        source: 'useSettings:fetchModels',
        message: 'Failed to fetch models for settings',
        details: err instanceof Error ? err : String(err),
      });
      console.error('Failed to fetch models:', err);
      throw err;
    } finally {
      isFetchingModels.value = false;
    }
  }

  async function save(patch: Partial<Settings>) {
    const oldUrl = _settings.value.endpointUrl;
    const oldType = _settings.value.endpointType;

    // Update local reactive state
    _settings.value = { ..._settings.value, ...patch };

    // If storage type is changed, handle provider switching/migration
    if (patch.storageType && patch.storageType !== storageService.getCurrentType()) {
      await storageService.switchProvider(patch.storageType);
    }

    // Persist as a patch to ensure we don't overwrite concurrent changes to other fields
    await storageService.updateSettings((curr) => {
      const base = curr || _settings.value;
      return { ...base, ...patch } as Settings;
    });

    // Re-fetch models if connection changed
    const urlChanged = patch.endpointUrl !== undefined && patch.endpointUrl !== oldUrl;
    const typeChanged = patch.endpointType !== undefined && patch.endpointType !== oldType;
    if (urlChanged || typeChanged) {
      await fetchModels();
    }
  }

  // --- Explicit Actions ---

  async function updateProviderProfiles(profiles: ProviderProfile[]) {
    const patch = { providerProfiles: [...profiles] };
    _settings.value.providerProfiles = patch.providerProfiles;
    await storageService.updateSettings((curr) => ({ ...(curr || _settings.value), ...patch } as Settings));
  }

  async function updateGlobalModel(modelId: string) {
    _settings.value.defaultModelId = modelId;
    await storageService.updateSettings((curr) => ({ ...(curr || _settings.value), defaultModelId: modelId }));
  }

  async function updateGlobalEndpoint(options: { type: EndpointType, url: string, headers?: [string, string][] }) {
    const oldUrl = _settings.value.endpointUrl;
    const oldType = _settings.value.endpointType;

    _settings.value.endpointType = options.type;
    _settings.value.endpointUrl = options.url;
    _settings.value.endpointHttpHeaders = options.headers;

    await storageService.updateSettings((curr) => ({
      ...(curr || _settings.value),
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
    await storageService.updateSettings((curr) => ({ ...(curr || _settings.value), systemPrompt: prompt }));
  }

  async function updateStorageType(type: StorageType) {
    if (_settings.value.storageType === type) return;

    _settings.value.storageType = type;
    await storageService.switchProvider(type);
    await storageService.updateSettings((curr) => ({ ...(curr || _settings.value), storageType: type }));
  }

  function setIsOnboardingDismissed(dismissed: boolean) {
    _isOnboardingDismissed.value = dismissed;
  }

  function setOnboardingDraft(draft: { url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null) {
    _onboardingDraft.value = draft;
  }

  function setHeavyContentAlertDismissed(dismissed: boolean) {
    _settings.value.heavyContentAlertDismissed = dismissed;
    storageService.updateSettings((curr) => ({ ...(curr || _settings.value), heavyContentAlertDismissed: dismissed }));
  }

  function setSearchPreviewMode({ mode }: { mode: SearchPreviewMode }) {
    _searchPreviewMode.value = mode;
  }

  function setSearchContextSize(size: number) {
    _searchContextSize.value = size;
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
    _searchPreviewMode.value = 'always';
    initPromise = null;
  }

  return {
    settings: readonly(_settings),
    initialized: readonly(_initialized),
    isOnboardingDismissed,
    onboardingDraft: readonly(_onboardingDraft),
    availableModels: readonly(availableModels),
    isFetchingModels: readonly(isFetchingModels),
    searchPreviewMode: readonly(_searchPreviewMode),
    searchContextSize: readonly(_searchContextSize),
    init,
    save,
    fetchModels,
    updateProviderProfiles,
    updateGlobalModel,
    updateGlobalEndpoint,
    updateSystemPrompt,
    updateStorageType,
    setIsOnboardingDismissed,
    setOnboardingDraft,
    setHeavyContentAlertDismissed,
    setSearchPreviewMode,
    setSearchContextSize,
    __testOnly: {
      __testOnlyReset,
      __testOnlySetSettings,
    },
  };
}
