import { describe, expect, it } from 'vitest';

import { TEST_ONLY } from './chat-generation-flow';

const { resolveGenerationModel } = TEST_ONLY;

describe('chat generation model resolution', () => {
  it('replaces a stale assistant model with the available browser-provided model', () => {
    expect(resolveGenerationModel({
      endpointType: 'openai',
      assistantModelId: 'previous-provider-model',
      resolvedModelId: 'another-stale-model',
      availableModels: ['browser-provided-language-model'],
    })).toBe('browser-provided-language-model');
  });

  it('does not synthesize a model when no persisted or resolved model exists', () => {
    expect(resolveGenerationModel({
      endpointType: 'openai',
      assistantModelId: undefined,
      resolvedModelId: '',
      availableModels: ['browser-provided-language-model'],
    })).toBe('');
  });

  it('preserves the preferred model when it remains available', () => {
    expect(resolveGenerationModel({
      endpointType: 'openai',
      assistantModelId: 'assistant-model',
      resolvedModelId: 'resolved-model',
      availableModels: ['assistant-model', 'resolved-model'],
    })).toBe('assistant-model');
  });
});

it('never replaces an explicit local file identity with a different listed model', () => {
  expect(resolveGenerationModel({ endpointType: 'llama_cpp_browser', assistantModelId: undefined, resolvedModelId: 'hf.co/owner/Model:Model-Q4_K_M.gguf', availableModels: ['user/other-GGUF'] })).toBe('hf.co/owner/Model:Model-Q4_K_M.gguf');
});
