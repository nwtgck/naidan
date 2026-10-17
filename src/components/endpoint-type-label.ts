import type { Endpoint } from '@/01-models/types';
import { lazyStrings } from '@/strings';
import { ENDPOINT_PRESETS } from '@/constants';

export function endpointTypeLabel({
  endpointType,
}: {
  endpointType: Endpoint['type'],
}): string | undefined {
  switch (endpointType) {
  case 'naidan_rpc': return 'Naidan RPC';
  case 'openai':
    return 'OpenAI';
  case 'ollama':
    return 'Ollama';
  case 'llama_cpp_browser':
    return 'llama.cpp browser';
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

/** Provider descriptions are presentation fallbacks, never endpoint configuration. */
export function endpointTypeDescription({ endpointType }: { endpointType: Endpoint['type'] }): string | undefined {
  switch (endpointType) {
  case 'openai':
    return lazyStrings.endpointTypeDescription__connect_to_an_openai_compatible_api();
  case 'ollama':
    return lazyStrings.endpointTypeDescription__connect_to_an_ollama_server();
  case 'naidan_rpc':
    return lazyStrings.endpointTypeDescription__use_models_from_a_registered_connection();
  case 'llama_cpp_browser':
    return lazyStrings.endpointTypeDescription__run_gguf_models_in_this_browser();
  case 'transformers_js':
    return lazyStrings.endpointTypeDescription__run_onnx_models_in_this_browser();
  case 'browser_provided_lm':
    return lazyStrings.endpointTypeDescription__use_models_built_into_your_browser();
  case 'unsupported_experimental_endpoint':
    return undefined;
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint description: ${_ex}`);
  }
  }
}

export function endpointUrlPlaceholder({ endpointType }: { endpointType: Endpoint['type'] | undefined }): string | undefined {
  switch (endpointType) {
  case 'openai':
  case 'ollama':
    return ENDPOINT_PRESETS.find(preset => preset.type === endpointType)?.url;
  case undefined:
  case 'naidan_rpc':
  case 'llama_cpp_browser':
  case 'transformers_js':
  case 'browser_provided_lm':
  case 'unsupported_experimental_endpoint':
    return undefined;
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint placeholder: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {
};
