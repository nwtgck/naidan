import type { Endpoint } from '@/01-models/types';
import { lazyStrings } from '@/strings';

export function endpointTypeLabel({
  endpointType,
}: {
  endpointType: Endpoint['type'],
}): string | undefined {
  switch (endpointType) {
  case 'openai':
    return 'OpenAI';
  case 'ollama':
    return 'Ollama';
  case 'transformers_js':
    return 'Transformers.js';
  case 'browser_provided_lm':
    return lazyStrings.SHARED__browser_provided();
  case 'unsupported_experimental_endpoint':
    return lazyStrings.SHARED__unsupported_experimental_endpoint();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {
};
