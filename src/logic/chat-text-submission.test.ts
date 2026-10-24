import { describe, expect, it } from 'vitest';
import { resolveChatTextSubmissionAction } from './chat-text-submission';

describe('chat text submission setup policy', () => {
  const configured = { type: 'openai', url: 'https://example.invalid' } as const;
  const unconfigured = { type: 'openai', url: '' } as const;

  it('submits only when the effective endpoint, model and runtime are ready', () => {
    expect(resolveChatTextSubmissionAction({
      endpoint: configured,
      modelId: 'model-1',
      canSubmit: true,
    })).toBe('send');
    expect(resolveChatTextSubmissionAction({
      endpoint: configured,
      modelId: 'model-1',
      canSubmit: false,
    })).toBe('blocked');
  });

  it.each([
    { endpoint: unconfigured, modelId: 'model-1' },
    { endpoint: configured, modelId: '' },
    { endpoint: unconfigured, modelId: '' },
  ])('offers model selection for incomplete effective setup: $endpoint / $modelId', ({ endpoint, modelId }) => {
    expect(resolveChatTextSubmissionAction({
      endpoint,
      modelId,
      canSubmit: false,
    })).toBe('select-model');
  });

  it.each(['chat', 'chat_group'] as const)('offers a chat-scoped selection for a broken %s endpoint override', _source => {
    expect(resolveChatTextSubmissionAction({
      endpoint: unconfigured,
      modelId: 'model-1',
      canSubmit: false,
    })).toBe('select-model');
  });

  it('does not present model selection as an escape from unrelated submission failures', () => {
    expect(resolveChatTextSubmissionAction({
      endpoint: configured,
      modelId: 'model-1',
      canSubmit: false,
    })).toBe('blocked');
  });
});
