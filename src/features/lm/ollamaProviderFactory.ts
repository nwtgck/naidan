import type { FakeLmDebugModeStatus } from '@/features/fake-lm/runtime/fakeLmDebugMode';
import { OllamaProvider } from '@/features/lm/ollama';
import { createLmFetch } from '@/features/lm/fetchFactory';
import { cloneEndpointHttpHeaders } from '@/features/lm/providerFactory';

export function createOllamaProvider({ endpointUrl, endpointHttpHeaders, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  endpointHttpHeaders: [string, string][] | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): OllamaProvider {
  return new OllamaProvider({
    endpoint: endpointUrl ?? '',
    headers: cloneEndpointHttpHeaders({ headers: endpointHttpHeaders }),
    fetcher: createLmFetch({ endpointUrl, fakeLmDebugModeStatus }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
