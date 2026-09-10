// @vitest-environment node
import { describe, expect, it } from 'vitest';
import publicInput from '@/features/transformers-js/production-replay-gemma4-e2b.input.evidence.json';
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE } from '@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image';
import { createModelSupportToolResultContinuationMessages, MODEL_SUPPORT_TOOL_RESULT_CONTENT } from './tool-protocol-fixture';
import { captureScenarioInput, captureProviderMessages, captureScenarios, isCaptureScenarioSelected } from './production-provider-capture-plan';

describe('versioned fixed Provider capture inputs', () => {
  it('keeps public system/history literals equal to existing evidence, not runtime-generated expectations', () => {
    expect(captureScenarioInput({ scenario: 'system-user', firstSettled: undefined }).messages).toEqual([
      { role: 'system', content: 'Template probe system instruction.' }, { role: 'user', content: 'Template probe user message.' },
    ]);
    expect(captureScenarioInput({ scenario: 'system-user', firstSettled: undefined }).messages).toEqual(publicInput.cases.find(item => item.caseId === 'system-user-generation')?.messages);
    expect(captureScenarioInput({ scenario: 'supplied-history', firstSettled: undefined }).messages).toEqual([
      { role: 'user', content: 'Template probe first user message.' }, { role: 'assistant', content: 'Template probe assistant response.' }, { role: 'user', content: 'Template probe second user message.' },
    ]);
    expect(publicInput.cases.some(item => JSON.stringify(item.messages) === JSON.stringify(captureScenarioInput({ scenario: 'supplied-history', firstSettled: undefined }).messages))).toBe(true);
  });

  it('projects the recorded structured control itself and matches the fixed public Tool continuation', () => {
    const input = captureScenarioInput({ scenario: 'structured-tool-history', firstSettled: undefined });
    const provider = captureProviderMessages({ input });
    expect(provider).toEqual(input.messages);
    expect(provider).toEqual(createModelSupportToolResultContinuationMessages({ toolCall: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' }, toolResultContent: MODEL_SUPPORT_TOOL_RESULT_CONTENT }));
    provider[0]!.content = 'mutated owned Provider copy';
    expect(input.messages[0]?.content).toBe('Use the weather tool for Tokyo.');
    expect(input.parameters.maxCompletionTokens).toBe(128);
    expect(Object.isFrozen(input.tools[0]?.parameters.properties.city)).toBe(true);
  });

  it('uses only the existing fixed PNG in public content parts with an independent one-token request', () => {
    const input = captureScenarioInput({ scenario: 'image', firstSettled: undefined });
    expect(input.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.prompt },
      { type: 'image_url', image_url: { url: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.dataUrl } },
    ] }]);
    expect(input.parameters.maxCompletionTokens).toBe(1);
    expect(captureProviderMessages({ input })).toEqual(input.messages);
    expect(MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.sha256).toBe('431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460');
  });

  it('selects scopes without model-name gates and keeps excluded rows explicit', () => {
    expect(captureScenarios({ plan: 'generation-v2' }).filter(scenario => isCaptureScenarioSelected({ plan: 'generation-v2', scenario }))).toEqual(['first-turn', 'system-user', 'supplied-history']);
    expect(captureScenarios({ plan: 'generation-capabilities-v2' }).filter(scenario => isCaptureScenarioSelected({ plan: 'generation-capabilities-v2', scenario }))).toEqual([
      'first-turn', 'system-user', 'supplied-history', 'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high', 'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
    ]);
    expect(captureScenarios({ plan: 'first-only' })).toEqual(['first-turn']);
    expect(captureScenarios({ plan: 'first-continuity-independent' })).toEqual(['first-turn', 'continuity', 'independent-next-input']);
  });
});
