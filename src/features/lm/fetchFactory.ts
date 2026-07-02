import { createFakeLmFetchForEndpoint, isFakeLmEndpointUrl, preloadFakeLmRuntime, type FakeLmDebugModeStatus } from '@/features/fake-lm';
import { getDefaultLmFetch, type LmFetch } from '@/features/lm/fetch';

export function createLmFetch({ endpointUrl, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): LmFetch {
  if (!shouldUseFakeLm({ endpointUrl, fakeLmDebugModeStatus })) {
    return getDefaultLmFetch();
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- this is a native fetch-compatible boundary.
  return async (input, init) => {
    const fakeLmFetch = await createFakeLmFetchForEndpoint({ endpointUrl, fakeLmDebugModeStatus });
    if (fakeLmFetch === undefined) {
      throw new Error('Fake LM runtime did not provide a fetch implementation for the fake endpoint');
    }
    return await fakeLmFetch(input, init);
  };
}

export async function prefetchFakeLmRuntime({ status }: {
  status: FakeLmDebugModeStatus,
}): Promise<void> {
  switch (status) {
  case 'enabled': {
    try {
      await preloadFakeLmRuntime();
    } catch (error) {
      console.error('Failed to prefetch Fake LM runtime:', error);
    }
    break;
  }
  case 'disabled':
    break;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
  }
  }
}

function shouldUseFakeLm({ endpointUrl, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): boolean {
  switch (fakeLmDebugModeStatus) {
  case 'enabled':
    return isFakeLmEndpointUrl({ endpointUrl });
  case 'disabled':
    return false;
  default: {
    const _ex: never = fakeLmDebugModeStatus;
    throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
