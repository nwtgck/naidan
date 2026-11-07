import { beforeEach, describe, expect, it } from 'vitest';

import { ensureAllStringsForTest } from '@/strings/utils.test-support';

import { endpointTypeLabel, ensureEndpointTypeLabel, endpointTypeDescription, endpointUrlPlaceholder } from './endpoint-type-label';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('endpointTypeLabel', () => {
  it('uses the localized in-browser llama.cpp name', () => {
    expect(endpointTypeLabel({ endpointType: 'llama_cpp_browser' })).toBe('llama.cpp in the browser');
  });

  it('uses the browser-provided label', () => {
    expect(endpointTypeLabel({ endpointType: 'browser_provided_lm' })).toBe('Browser-provided');
  });
});

describe('endpointTypeDescription', () => {
  it.each([
    ['naidan_rpc', 'Use models from a registered connection'],
    ['llama_cpp_browser', 'Run GGUF models in this browser'],
    ['transformers_js', 'Run ONNX models in this browser'],
    ['browser_provided_lm', 'Use models built into your browser'],
  ] as const)('describes %s without replacing provider identity', (endpointType, description) => {
    expect(endpointTypeDescription({ endpointType })).toBe(description);
  });

  it('describes HTTP connections and does not describe an unknown experimental provider', () => {
    expect(endpointTypeDescription({ endpointType: 'openai' })).toBe('Connect to an OpenAI-compatible API');
    expect(endpointTypeDescription({ endpointType: 'ollama' })).toBe('Connect to an Ollama server');
    expect(endpointTypeDescription({ endpointType: 'unsupported_experimental_endpoint' })).toBeUndefined();
  });
});

describe('endpointUrlPlaceholder', () => {
  it('uses provider-specific examples without supplying URLs for non-HTTP endpoints', () => {
    expect(endpointUrlPlaceholder({ endpointType: 'openai' })).toBe('http://localhost:1234/v1');
    expect(endpointUrlPlaceholder({ endpointType: 'ollama' })).toBe('http://localhost:11434');
    expect(endpointUrlPlaceholder({ endpointType: 'llama_cpp_browser' })).toBeUndefined();
    expect(endpointUrlPlaceholder({ endpointType: undefined })).toBeUndefined();
  });
});

describe('ensureEndpointTypeLabel', () => {
  it.each(['openai', 'ollama', 'naidan_rpc', 'llama_cpp_browser', 'transformers_js', 'browser_provided_lm', 'unsupported_experimental_endpoint'] as const)('resolves the same complete name for imperative use: %s', async endpointType => {
    expect(await ensureEndpointTypeLabel({ endpointType })).toBe(endpointTypeLabel({ endpointType }));
  });
});
