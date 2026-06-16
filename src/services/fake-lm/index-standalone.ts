import { ref } from 'vue';

import type { LmFetch } from '@/services/lm/fetch';

export const FAKE_LM_ENDPOINT_HOSTNAME = 'fake-lm.invalid';
export const FAKE_LM_ENDPOINT_URL = `https://${FAKE_LM_ENDPOINT_HOSTNAME}`;

export type FakeLmDebugModeAvailability = 'available' | 'unavailable_in_standalone';
export type FakeLmDebugModeStatus = 'enabled' | 'disabled';

const fakeLmDebugModeAvailability = ref<FakeLmDebugModeAvailability>('unavailable_in_standalone');
const fakeLmDebugModeStatus = ref<FakeLmDebugModeStatus>('disabled');

export function isFakeLmEndpointUrl({ endpointUrl }: {
  endpointUrl: string | undefined;
}): boolean {
  if (endpointUrl === undefined) {
    return false;
  }

  try {
    const url = new URL(endpointUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname === FAKE_LM_ENDPOINT_HOSTNAME
    );
  } catch {
    return false;
  }
}

export function useFakeLmDebugMode() {
  function setFakeLmDebugModeStatus({ status: _status }: {
    status: FakeLmDebugModeStatus;
  }): void {
    fakeLmDebugModeStatus.value = 'disabled';
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

export function createFakeLmFetchForEndpoint({ endpointUrl: _endpointUrl }: {
  endpointUrl: string | undefined;
}): LmFetch | undefined {
  return undefined;
}

export function preloadFakeLmLanguagePacks(): void {
  // Standalone builds intentionally exclude hosted fake LM language data.
}
