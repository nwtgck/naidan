import type { LmProvider } from '@/01-models/lm';
import type { Endpoint, EndpointType } from '@/01-models/types';
import type { FakeLmDebugModeStatus } from '@/features/fake-lm/runtime/fakeLmDebugMode';
import { createLmFetch } from '@/features/lm/fetchFactory';
import { createModuleLoader } from '@/utils/module-loader';

const openAiProviderModuleLoader = createModuleLoader({
  importModule: () => import('@/features/lm/openai'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch OpenAI provider:', error);
  },
});

const ollamaProviderModuleLoader = createModuleLoader({
  importModule: () => import('@/features/lm/ollama'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Ollama provider:', error);
  },
});

const transformersJsProviderModuleLoader = createModuleLoader({
  importModule: () => import('@/features/transformers-js/provider'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Transformers.js provider:', error);
  },
});

export async function loadLmProvider({ endpoint, fakeLmDebugModeStatus }: {
  endpoint: Endpoint,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): Promise<LmProvider> {
  switch (endpoint.type) {
  case 'openai': {
    const { OpenAIProvider } = await openAiProviderModuleLoader.load();
    return new OpenAIProvider({
      endpoint: endpoint.url,
      headers: cloneEndpointHttpHeaders({ headers: endpoint.httpHeaders }),
      fetcher: createLmFetch({ endpointUrl: endpoint.url, fakeLmDebugModeStatus }),
    });
  }
  case 'ollama': {
    const { OllamaProvider } = await ollamaProviderModuleLoader.load();
    return new OllamaProvider({
      endpoint: endpoint.url ?? '',
      headers: cloneEndpointHttpHeaders({ headers: endpoint.httpHeaders }),
      fetcher: createLmFetch({ endpointUrl: endpoint.url, fakeLmDebugModeStatus }),
    });
  }
  case 'transformers_js': {
    const { TransformersJsProvider } = await transformersJsProviderModuleLoader.load();
    return new TransformersJsProvider();
  }
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

export async function prefetchLmProvider({ endpointType }: {
  endpointType: EndpointType,
}): Promise<void> {
  switch (endpointType) {
  case 'openai':
    await openAiProviderModuleLoader.prefetch();
    break;
  case 'ollama':
    await ollamaProviderModuleLoader.prefetch();
    break;
  case 'transformers_js':
    await transformersJsProviderModuleLoader.prefetch();
    break;
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

export function cloneEndpointHttpHeaders({ headers }: {
  headers: [string, string][] | undefined,
}): [string, string][] | undefined {
  return headers === undefined
    ? undefined
    : headers.map(([name, value]) => [name, value]);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
