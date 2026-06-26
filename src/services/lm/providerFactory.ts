import type { EndpointType } from '@/models/types';
import { createFakeLmFetchForEndpoint, type FakeLmDebugModeStatus } from '@/services/fake-lm';
import { getDefaultLmFetch, type LmFetch } from '@/services/lm/fetch';
import { OllamaProvider } from '@/services/lm/ollama';
import { OpenAIProvider } from '@/services/lm/openai';
import type { LmProvider } from '@/services/lm/types';
import { TransformersJsProvider } from '@/services/transformers-js/provider';

export function createLmProvider({ endpointType, endpointUrl, endpointHttpHeaders, fakeLmDebugModeStatus }: {
  endpointType: EndpointType,
  endpointUrl: string | undefined,
  endpointHttpHeaders: [string, string][] | undefined,
  fakeLmDebugModeStatus: FakeLmDebugModeStatus,
}): LmProvider {
  const headers = cloneEndpointHttpHeaders({ headers: endpointHttpHeaders });

  switch (endpointType) {
  case 'openai':
    return new OpenAIProvider({
      endpoint: endpointUrl ?? '',
      headers,
      fetcher: createLmFetch({ endpointUrl, fakeLmDebugModeStatus }),
    });
  case 'ollama':
    return createOllamaProvider({
      endpointUrl,
      endpointHttpHeaders,
      fakeLmDebugModeStatus,
    });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
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
