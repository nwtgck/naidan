import { describe, expect, it } from 'vitest';

import { TEST_ONLY } from './chat-generation-flow';

const { resolveGenerationModel } = TEST_ONLY;

describe('chat generation model resolution', () => {
  it('uses the browser-managed Prompt API model when regenerating an older node', () => {
    expect(resolveGenerationModel({
      endpoint: { type: 'prompt_api' },
      assistantModelId: 'previous-provider-model',
      resolvedModelId: 'another-stale-model',
    })).toBe('browser-provided-language-model');
  });

  it('preserves normal endpoint model precedence', () => {
    expect(resolveGenerationModel({
      endpoint: { type: 'openai', url: 'https://example.test' },
      assistantModelId: 'assistant-model',
      resolvedModelId: 'resolved-model',
    })).toBe('assistant-model');
  });
});
