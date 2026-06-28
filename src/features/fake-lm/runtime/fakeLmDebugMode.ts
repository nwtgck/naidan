import { ref } from 'vue';

export type FakeLmDebugModeAvailability = 'available' | 'unavailable_in_standalone';
export type FakeLmDebugModeStatus = 'enabled' | 'disabled';

const fakeLmDebugModeAvailability = ref<FakeLmDebugModeAvailability>('available');

export function useFakeLmDebugMode() {
  return {
    fakeLmDebugModeAvailability,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for useXxx return objects.
    },
  };
}
