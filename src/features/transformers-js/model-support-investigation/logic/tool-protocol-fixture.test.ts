// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { ChatMessage, ToolCall } from '@/01-models/types';
import { createTransformersJsProvider, type TransformersJsProviderService } from '@/features/transformers-js/provider-hosted';
import type { InferenceMessage } from '@/features/transformers-js/types';
import { createModelSupportWeatherTool, MODEL_SUPPORT_TOOL_DEFINITIONS } from './tool-protocol-fixture';
import { runProviderTestInferenceOperation } from '@/features/transformers-js/provider-inference-test-scope';
import { runProviderReplayTurn } from '@/features/transformers-js/replay-models/support/provider-replay-chat';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Synthetic weather Tool must not access the network');
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => {
    throw new Error('Synthetic weather Tool must not access storage');
  }) } });
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// This fixture checks public Provider/tool mechanics with a controlled service.
// It does not supply a model-output oracle or claim native tool generation works.
function providerFixture({ call }: { call: ToolCall }) {
  type StructuredService = TransformersJsProviderService & Pick<Parameters<typeof runProviderTestInferenceOperation>[0]['service'], 'generateMessage'>;
  const requests: InferenceMessage[][] = [];
  const generate = vi.fn<NonNullable<StructuredService['generateMessage']>>(async ({ messages, onEvent }) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) {
      await onEvent({ event: { type: 'tool_start', index: 0 } });
      await onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } });
      await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'tool_results' } } });
    } else {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'Synthetic final answer.' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
      await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
    }
  });
  const load = vi.fn<TransformersJsProviderService['loadDownloadedModel']>(async () => {
    throw new Error('The controlled service is already ready');
  });
  const service: StructuredService = {
    runInferenceOperation(args) {
      return runProviderTestInferenceOperation({ ...args, service });
    },
    getState: () => ({ status: 'ready', activeModelId: 'fixture/weather' }),
    loadDownloadedModel: load,
    generateText: vi.fn<TransformersJsProviderService['generateText']>().mockRejectedValue(new Error('The legacy stream must not be used.')),
    generateMessage: generate,
    listCachedModels: async () => [],
  };
  return { provider: createTransformersJsProvider({ service }), requests, generate, load };
}

describe('Fixed investigation weather Tool at the public Provider boundary', () => {
  it('returns only the fixed result without reading argument data or calling optional hooks', async () => {
    const argumentGetter = vi.fn(() => {
      throw new Error('Synthetic argument must not be inspected by the fixed executor');
    });
    const args = Object.defineProperty({}, 'city', { get: argumentGetter });
    const onEvent = vi.fn();
    const tool = createModelSupportWeatherTool();
    await expect(tool.execute({ args, signal: undefined, onEvent, approvalContext: undefined })).resolves.toEqual({
      status: 'success', content: '{"temperatureC":20,"condition":"clear"}',
    });
    expect(argumentGetter).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not echo an unexpected generated city or share a mutable Tool instance across runs', async () => {
    const first = createModelSupportWeatherTool();
    const second = createModelSupportWeatherTool();
    expect(second).not.toBe(first);
    first.name = 'mutated-test-tool';
    expect(second.name).toBe('lookup_weather');
    await expect(second.execute({ args: { city: 'synthetic-private-value' }, signal: undefined, onEvent: undefined, approvalContext: undefined })).resolves.toEqual({
      status: 'success', content: '{"temperatureC":20,"condition":"clear"}',
    });
  });

  it('lets the real Provider serialize the strict definition and the turn runner feed the exact result into its next request', async () => {
    const call: ToolCall = {
      id: toToolCallId({ raw: 'call_model_support_weather' }), type: 'function',
      function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
    };
    const fixture = providerFixture({ call });
    const tool = createModelSupportWeatherTool();
    const execute = vi.spyOn(tool, 'execute');
    const input: ChatMessage[] = [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [
      { type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' },
    ] }];
    const original = structuredClone(input);
    const turn = await runProviderReplayTurn({
      provider: fixture.provider,
      request: { model: 'fixture/weather', messages: input, parameters: undefined, readBinaryObject: undefined, debug: undefined },
      tools: [tool],
      abortController: new AbortController(),
      onChange: undefined,
    });
    expect(turn.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
    expect(fixture.generate.mock.calls.map(([request]) => request.tools)).toEqual([0, 1].map(() => [{
      type: 'function', function: {
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      },
    }]));
    expect(fixture.requests).toEqual([
      [{ role: 'user', content: 'Use the weather tool for Tokyo.' }],
      [
        { role: 'user', content: 'Use the weather tool for Tokyo.' },
        { role: 'assistant', content: [], tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: '{"temperatureC":20,"condition":"clear"}' },
      ],
    ]);
    expect(input).toEqual(original);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].args).toEqual({ city: 'Tokyo' });
    expect(turn.generated).toMatchObject([
      { role: 'assistant', parts: [{ type: 'tool_call', toolCall: call }] },
      { role: 'tool', parts: [{ type: 'tool_result', result: {
        toolCallId: call.id, status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' },
      } }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Synthetic final answer.', completeness: 'complete' }] },
    ]);
    expect(fixture.load).not.toHaveBeenCalled();
    // The independent native template fixture remains open; public validation
    // must not be bypassed to make its schema identical to historical evidence.
    expect(MODEL_SUPPORT_TOOL_DEFINITIONS[0]!.function.parameters).toEqual({
      type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
    });
  });

  it('leaves invalid arguments to the real turn runner validation and never executes the fixed Tool', async () => {
    const call: ToolCall = {
      id: toToolCallId({ raw: 'call_model_support_invalid_weather' }), type: 'function',
      function: { name: 'lookup_weather', arguments: '{"city":"Tokyo","extra":"synthetic"}' },
    };
    const fixture = providerFixture({ call });
    const tool = createModelSupportWeatherTool();
    const execute = vi.spyOn(tool, 'execute');
    const turn = await runProviderReplayTurn({
      provider: fixture.provider,
      request: {
        model: 'fixture/weather',
        messages: [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [
          { type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' },
        ] }],
        parameters: undefined,
        readBinaryObject: undefined,
        debug: undefined,
      },
      tools: [tool],
      abortController: new AbortController(),
      onChange: undefined,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(turn.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
    expect(turn.generated.filter(message => message.role === 'tool')).toMatchObject([
      { parts: [{ type: 'tool_result', result: { toolCallId: call.id, status: 'error', error: { code: 'invalid_arguments' } } }] },
    ]);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.load).not.toHaveBeenCalled();
  });
});
