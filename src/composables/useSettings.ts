import { ref } from 'vue';
import { type Settings, DEFAULT_SETTINGS } from '../models/types';
import { storageService } from '../services/storage';

const settings = ref<Settings>({ ...DEFAULT_SETTINGS });
const initialized = ref(false);

export function useSettings() {
  const loading = ref(false);

  async function init() {
    if (initialized.value) return;
    loading.value = true;
    try {
      await storageService.init();
      const s = await storageService.loadSettings();
      if (s) {
        settings.value = s;
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
    init,
    save,
  };
}
