import { ref } from 'vue';
import { preloadFakeLmLanguagePacks } from '@/services/fake-lm/core/lexiconLoader';

export type FakeLmDebugModeAvailability = 'available' | 'unavailable_in_standalone';
export type FakeLmDebugModeStatus = 'enabled' | 'disabled';

const fakeLmDebugModeAvailability = ref<FakeLmDebugModeAvailability>('available');
const fakeLmDebugModeStatus = ref<FakeLmDebugModeStatus>('disabled');

export function useFakeLmDebugMode() {
  function setFakeLmDebugModeStatus({ status }: {
    status: FakeLmDebugModeStatus;
  }): void {
    fakeLmDebugModeStatus.value = status;
    switch (status) {
    case 'enabled':
      preloadFakeLmLanguagePacks();
      break;
    case 'disabled':
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
    }
    }
  }

  return {
    fakeLmDebugModeAvailability,
    fakeLmDebugModeStatus,
    setFakeLmDebugModeStatus,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for useXxx return objects.
    },
  };
}
