import type { Endpoint } from '@/models/types';
import { createFakeLmFetchForEndpoint, type FakeLmDebugModeStatus } from '@/services/fake-lm';
import { getDefaultLmFetch, type LmFetch } from '@/services/lm/fetch';
import { OllamaProvider } from '@/services/lm/ollama';
import { OpenAIProvider } from '@/services/lm/openai';
import type { LmProvider } from '@/services/lm/types';
import { TransformersJsProvider } from '@/services/transformers-js/provider';

export function createLmProvider({ endpoint, fakeLmDebugModeStatus }: {
  endpoint: Endpoint,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): LmProvider {
  switch (endpoint.type) {
  case 'openai':
    return new OpenAIProvider({
      endpoint: endpoint.url,
      headers: cloneEndpointHttpHeaders({ headers: endpoint.httpHeaders }),
      fetcher: createLmFetch({
        endpointUrl: endpoint.url,
        fakeLmDebugModeStatus,
      }),
    });
  case 'ollama':
    return createOllamaProvider({
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.httpHeaders,
      fakeLmDebugModeStatus,
    });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

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

export function createLmFetch({ endpointUrl, fakeLmDebugModeStatus }: {
  endpointUrl: string | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): LmFetch {
  const fakeLmFetch = createFakeLmFetchForEndpoint({
    endpointUrl,
    fakeLmDebugModeStatus,
  });

  if (fakeLmFetch !== undefined) {
    return fakeLmFetch;
  }

  return getDefaultLmFetch();
}

export function cloneEndpointHttpHeaders({ headers }: {
  headers: [string, string][] | undefined,
}): [string, string][] | undefined {
  return headers === undefined
    ? undefined
    : headers.map(([name, value]) => [name, value]);
}
