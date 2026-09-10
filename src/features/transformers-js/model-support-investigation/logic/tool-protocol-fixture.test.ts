// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolCallId } from '@/01-models/ids';
import type { ChatMessage, ToolCall } from '@/01-models/types';
import { createTransformersJsProvider, type TransformersJsProviderService } from '@/features/transformers-js/provider-hosted';
import { createModelSupportWeatherTool, MODEL_SUPPORT_TOOL_DEFINITIONS } from './tool-protocol-fixture';

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
  const requests: ChatMessage[][] = [];
  const generate = vi.fn<TransformersJsProviderService['generateText']>(async ({ messages, onToolCalls, onChunk }) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) onToolCalls({ toolCalls: [call] });
    else onChunk({ chunk: 'Synthetic final answer.' });
  });
  const load = vi.fn<TransformersJsProviderService['loadDownloadedModel']>(async () => {
    throw new Error('The controlled service is already ready');
  });
  const service: TransformersJsProviderService = {
    getState: () => ({ status: 'ready', activeModelId: 'fixture/weather' }),
    loadDownloadedModel: load,
    generateText: generate,
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

  it('lets the real Provider serialize the strict definition and feed the exact result into its next request', async () => {
    const call: ToolCall = {
      id: toToolCallId({ raw: 'call_model_support_weather' }), type: 'function',
      function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
    };
    const fixture = providerFixture({ call });
    const tool = createModelSupportWeatherTool();
    const execute = vi.spyOn(tool, 'execute');
    const input: ChatMessage[] = [{ role: 'user', content: 'Use the weather tool for Tokyo.' }];
    const chunks: string[] = [];
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    await fixture.provider.chat({
      model: 'fixture/weather', messages: input, tools: [tool],
      onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
    });
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
        { role: 'assistant', content: '', tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: '{"temperatureC":20,"condition":"clear"}' },
      ],
    ]);
    expect(input).toEqual([{ role: 'user', content: 'Use the weather tool for Tokyo.' }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].args).toEqual({ city: 'Tokyo' });
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith({ id: call.id, toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ id: call.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' } });
    expect(chunks).toEqual(['Synthetic final answer.']);
    expect(fixture.load).not.toHaveBeenCalled();
    // The independent native template fixture remains open; public validation
    // must not be bypassed to make its schema identical to historical evidence.
    expect(MODEL_SUPPORT_TOOL_DEFINITIONS[0]!.function.parameters).toEqual({
      type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
    });
  });

  it('leaves invalid arguments to the real Provider validation and never executes the fixed Tool', async () => {
    const call: ToolCall = {
      id: toToolCallId({ raw: 'call_model_support_invalid_weather' }), type: 'function',
      function: { name: 'lookup_weather', arguments: '{"city":"Tokyo","extra":"synthetic"}' },
    };
    const fixture = providerFixture({ call });
    const tool = createModelSupportWeatherTool();
    const execute = vi.spyOn(tool, 'execute');
    const onToolResult = vi.fn();
    await fixture.provider.chat({
      model: 'fixture/weather', messages: [{ role: 'user', content: 'Use the weather tool for Tokyo.' }],
      tools: [tool], onChunk: () => {}, onToolResult,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledOnce();
    expect(onToolResult.mock.calls[0]![0]).toMatchObject({ id: call.id, result: { status: 'error', code: 'invalid_arguments' } });
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.load).not.toHaveBeenCalled();
  });
});
