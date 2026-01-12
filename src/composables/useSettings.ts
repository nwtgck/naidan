import { ref } from 'vue';
import { type Settings, type EndpointType, DEFAULT_SETTINGS } from '../models/types';
import { storageService } from '../services/storage';
import { STORAGE_BOOTSTRAP_KEY } from '../models/constants';

const settings = ref<Settings>({ ...DEFAULT_SETTINGS });
const initialized = ref(false);
const isOnboardingDismissed = ref(false);
const onboardingDraft = ref<{ url: string, type: EndpointType, models: string[], selectedModel: string } | null>(null);

export function useSettings() {
  const loading = ref(false);

  async function init() {
    if (initialized.value) return;
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
        }
      }
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function save(newSettings: Settings) {
    settings.value = { ...newSettings }; // Update state immediately
    
    // Check if storage type changed from what the service is currently using
    const currentProviderType = storageService.getCurrentType();
    
    if (newSettings.storageType !== currentProviderType) {
      await storageService.switchProvider(newSettings.storageType);
    }
    
    // Save to the (potentially new) provider
    await storageService.saveSettings(settings.value);
  }

  return {
    settings,
    loading,
    initialized,
    isOnboardingDismissed,
    onboardingDraft,
    init,
    save,
  };
}
