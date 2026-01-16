import { ref } from 'vue';
import { type Settings, type EndpointType, DEFAULT_SETTINGS } from '../models/types';
import { storageService } from '../services/storage';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';
import { OpenAIProvider, OllamaProvider } from '../services/llm';

const settings = ref<Settings>({ ...DEFAULT_SETTINGS });
const initialized = ref(false);
const isOnboardingDismissed = ref(false);
const onboardingDraft = ref<{ url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null>(null);
const availableModels = ref<string[]>([]);
const isFetchingModels = ref(false);

let initPromise: Promise<void> | null = null;

export function useSettings() {
  const loading = ref(false);

  async function init() {
    if (initialized.value) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      loading.value = true;
      try {
        // Determine storage type from persisted flag
        let bootstrapType: 'local' | 'opfs' = 'local';
        if (typeof localStorage !== 'undefined') {
          const saved = localStorage.getItem(STORAGE_BOOTSTRAP_KEY);
          if (saved === 'opfs') bootstrapType = 'opfs';
        }

        await storageService.init(bootstrapType);
        const s = await storageService.loadSettings();
        if (s) {
          settings.value = s;
          if (s.endpointUrl) {
            isOnboardingDismissed.value = true;
            // Initial fetch of models if we have an endpoint
            fetchModels();
          }
        }
      } finally {
        loading.value = false;
        initialized.value = true;
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function fetchModels() {
    if (!settings.value.endpointUrl) {
      availableModels.value = [];
      return;
    }
    isFetchingModels.value = true;
    try {
      const provider = settings.value.endpointType === 'ollama' 
        ? new OllamaProvider() 
        : new OpenAIProvider();
      
      const models = await provider.listModels(settings.value.endpointUrl, settings.value.endpointHttpHeaders);
      availableModels.value = models;
    } catch (err) {
      console.error('Failed to fetch models:', err);
      // We don't clear availableModels on error if we already have some, 
      // but maybe we should if it's a connection error.
    } finally {
      isFetchingModels.value = false;
    }
  }

  async function save(newSettings: Settings) {
    const oldUrl = settings.value.endpointUrl;
    const oldType = settings.value.endpointType;
    
    settings.value = { ...newSettings }; // Update state immediately
    
    // Check if storage type changed from what the service is currently using
    const currentProviderType = storageService.getCurrentType();
    
    if (newSettings.storageType !== currentProviderType) {
      await storageService.switchProvider(newSettings.storageType);
    }
    
    // Save to the (potentially new) provider
    await storageService.saveSettings(settings.value);

    // If endpoint changed, refetch models
    if (newSettings.endpointUrl !== oldUrl || newSettings.endpointType !== oldType) {
      await fetchModels();
    }
  }

  return {
    settings,
    loading,
    initialized,
    isOnboardingDismissed,
    onboardingDraft,
    availableModels,
    isFetchingModels,
    init,
    save,
    fetchModels,
  };
}
