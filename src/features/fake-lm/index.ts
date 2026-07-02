import type { LmFetch } from '@/features/lm/fetch';
import type { FakeLmDebugModeStatus } from '@/features/fake-lm/runtime/fakeLmDebugMode';
import { createModuleLoader } from '@/utils/module-loader';

export {
  FAKE_LM_ENDPOINT_HOSTNAME,
  FAKE_LM_ENDPOINT_URL,
  isFakeLmEndpointUrl,
} from '@/features/fake-lm/api/fakeLmEndpointUrl';
export {
  useFakeLmDebugMode,
  type FakeLmDebugModeAvailability,
  type FakeLmDebugModeStatus,
} from '@/features/fake-lm/runtime/fakeLmDebugMode';

const fakeLmFetchModuleLoader = createModuleLoader({
  importModule: () => import('@/features/fake-lm/hosted/fakeLmFetchForEndpoint'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Fake LM fetch runtime:', error);
  },
});

const fakeLmLexiconModuleLoader = createModuleLoader({
  importModule: () => import('@/features/fake-lm/core/lexiconLoader'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Fake LM language packs:', error);
  },
});

export async function createFakeLmFetchForEndpoint({ endpointUrl, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): Promise<LmFetch | undefined> {
  const { createFakeLmFetchForEndpoint } = await fakeLmFetchModuleLoader.load();
  return createFakeLmFetchForEndpoint({ endpointUrl, fakeLmDebugModeStatus });
}

export async function preloadFakeLmRuntime(): Promise<void> {
  const [, { preloadFakeLmLanguagePacks }] = await Promise.all([
    fakeLmFetchModuleLoader.load(),
    fakeLmLexiconModuleLoader.load(),
  ]);
  await preloadFakeLmLanguagePacks();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
