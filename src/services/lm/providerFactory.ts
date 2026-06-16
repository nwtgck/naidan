import type { EndpointType } from '@/models/types';
import { createFakeLmFetchForEndpoint } from '@/services/fake-lm';
import { getDefaultLmFetch, type LmFetch } from '@/services/lm/fetch';
import { OllamaProvider } from '@/services/lm/ollama';
import { OpenAIProvider } from '@/services/lm/openai';
import type { LLMProvider } from '@/services/lm/types';
import { TransformersJsProvider } from '@/services/transformers-js/provider';

export function createLmProvider({ endpointType, endpointUrl, endpointHttpHeaders }: {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
}): LLMProvider {
  const headers = cloneEndpointHttpHeaders({ headers: endpointHttpHeaders });

  switch (endpointType) {
  case 'openai':
    return new OpenAIProvider({
      endpoint: endpointUrl ?? '',
      headers,
      fetcher: createLmFetch({ endpointUrl }),
    });
  case 'ollama':
    return new OllamaProvider({
      endpoint: endpointUrl ?? '',
      headers,
      fetcher: createLmFetch({ endpointUrl }),
    });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

export function createLmFetch({ endpointUrl }: {
  endpointUrl: string | undefined;
}): LmFetch {
  const fakeLmFetch = createFakeLmFetchForEndpoint({
    endpointUrl,
  });

  if (fakeLmFetch !== undefined) {
    return fakeLmFetch;
  }

  return getDefaultLmFetch();
}

export function cloneEndpointHttpHeaders({ headers }: {
  headers: [string, string][] | undefined;
}): [string, string][] | undefined {
  return headers === undefined
    ? undefined
    : headers.map(([name, value]) => [name, value]);
}
