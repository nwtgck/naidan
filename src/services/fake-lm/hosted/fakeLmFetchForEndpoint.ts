import { fakeLmFetch } from '@/services/fake-lm/api/fakeLmFetch';
import { isFakeLmEndpointUrl } from '@/services/fake-lm/api/fakeLmEndpointUrl';
import { useFakeLmDebugMode, type FakeLmDebugModeAvailability, type FakeLmDebugModeStatus } from '@/services/fake-lm/runtime/fakeLmDebugMode';
import type { LmFetch } from '@/services/lm/fetch';

export function createFakeLmFetchForEndpoint({ endpointUrl }: {
  endpointUrl: string | undefined;
}): LmFetch | undefined {
  const { fakeLmDebugModeAvailability, fakeLmDebugModeStatus } = useFakeLmDebugMode();

  if (!isFakeLmDebugModeAvailable({ availability: fakeLmDebugModeAvailability.value })) {
    return undefined;
  }

  if (!isFakeLmDebugModeEnabled({ status: fakeLmDebugModeStatus.value })) {
    return undefined;
  }

  if (!isFakeLmEndpointUrl({ endpointUrl })) {
    return undefined;
  }

  return fakeLmFetch;
}

function isFakeLmDebugModeAvailable({ availability }: {
  availability: FakeLmDebugModeAvailability;
}): boolean {
  switch (availability) {
  case 'available':
    return true;
  case 'unavailable_in_standalone':
    return false;
  default: {
    const _ex: never = availability;
    throw new Error(`Unhandled fake LM debug mode availability: ${_ex}`);
  }
  }
}

function isFakeLmDebugModeEnabled({ status }: {
  status: FakeLmDebugModeStatus;
}): boolean {
  switch (status) {
  case 'enabled':
    return true;
  case 'disabled':
    return false;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
  }
  }
}
