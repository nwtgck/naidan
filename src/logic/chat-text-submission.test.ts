import { describe, expect, it } from 'vitest';
import { resolveChatTextSubmissionAction } from './chat-text-submission';

describe('chat text submission setup policy', () => {
  const configured = { type: 'openai', url: 'https://example.invalid' } as const;
  const unconfigured = { type: 'openai', url: '' } as const;

  it('submits only when the effective endpoint, model and runtime are ready', () => {
    expect(resolveChatTextSubmissionAction({
      endpoint: configured,
      modelId: 'model-1',
      endpointSource: 'global',
      modelSource: 'global',
      globalSetupIncomplete: false,
      canSubmit: true,
    })).toBe('send');
    expect(resolveChatTextSubmissionAction({
      endpoint: configured,
      modelId: 'model-1',
      endpointSource: 'global',
      modelSource: 'global',
      globalSetupIncomplete: false,
      canSubmit: false,
    })).toBe('blocked');
  });

  it.each([
    { endpoint: unconfigured, modelId: 'model-1' },
    { endpoint: configured, modelId: '' },
    { endpoint: unconfigured, modelId: '' },
  ])('offers onboarding for incomplete inherited global setup: $endpoint / $modelId', ({ endpoint, modelId }) => {
    expect(resolveChatTextSubmissionAction({
      endpoint,
      modelId,
      endpointSource: 'global',
      modelSource: 'global',
      globalSetupIncomplete: true,
      canSubmit: false,
    })).toBe('open-onboarding');
  });

  it.each(['chat', 'chat_group'] as const)('does not offer global onboarding for a broken %s endpoint override', source => {
    expect(resolveChatTextSubmissionAction({
      endpoint: unconfigured,
      modelId: 'model-1',
      endpointSource: source,
      modelSource: 'global',
      globalSetupIncomplete: true,
      canSubmit: false,
    })).toBe('blocked');
  });

  it('does not present onboarding as an escape from unrelated submission failures', () => {
    expect(resolveChatTextSubmissionAction({
      endpoint: unconfigured,
      modelId: '',
      endpointSource: 'global',
      modelSource: 'global',
      globalSetupIncomplete: false,
      canSubmit: false,
    })).toBe('blocked');
  });
});
