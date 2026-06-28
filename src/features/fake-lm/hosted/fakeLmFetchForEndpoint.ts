import { fakeLmFetch } from '@/features/fake-lm/api/fakeLmFetch';
import { isFakeLmEndpointUrl } from '@/features/fake-lm/api/fakeLmEndpointUrl';
import type { FakeLmDebugModeStatus } from '@/features/fake-lm/runtime/fakeLmDebugMode';
import type { LmFetch } from '@/features/lm/fetch';

export function createFakeLmFetchForEndpoint({ endpointUrl, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): LmFetch | undefined {
  if (!isFakeLmDebugModeEnabled({ status: fakeLmDebugModeStatus })) {
    return undefined;
  }

  if (!isFakeLmEndpointUrl({ endpointUrl })) {
    return undefined;
  }

  return fakeLmFetch;
}

function isFakeLmDebugModeEnabled({ status }: {
  status: FakeLmDebugModeStatus,
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
