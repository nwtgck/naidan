// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toToolCallId } from '@/01-models/ids';
import type { ChatMessage, ToolCall } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { createTransformersJsProvider, type TransformersJsProviderService } from './provider-hosted';

const ordinaryService = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('Isolated Provider reached ordinary state');
  }),
  loadDownloadedModel: vi.fn(async () => {
    throw new Error('Isolated Provider reached ordinary Load');
  }),
  generateText: vi.fn(async () => {
    throw new Error('Isolated Provider reached ordinary generation');
  }),
  listCachedModels: vi.fn(async () => {
    throw new Error('Isolated Provider reached ordinary inventory');
  }),
}));
vi.mock('./index', () => ({ transformersJsService: ordinaryService }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Provider isolation test forbids network access');
  }));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// Deliberately a service-boundary unit fixture. Real service/Worker isolation
// requires separate lifecycle tests; this does not claim independent Realms.
function createServiceFixture({ modelId, answer }: { modelId: string, answer: string }) {
  let activeModelId: string | undefined;
  const service: TransformersJsProviderService = {
    getState() {
      expect(this).toBe(service);
      return { status: activeModelId === undefined ? 'idle' : 'ready', activeModelId };
    },
    async loadDownloadedModel({ modelId: requestedModel }) {
      expect(this).toBe(service);
      expect(requestedModel).toBe(modelId);
      activeModelId = requestedModel;
    },
    async generateText({ onChunk }) {
      expect(this).toBe(service);
      onChunk({ chunk: answer });
    },
    async listCachedModels() {
      expect(this).toBe(service);
      return [{ id: modelId, isLocal: false, size: 1, fileCount: 1, lastModified: 0, isComplete: true }];
    },
  };
  const load = vi.spyOn(service, 'loadDownloadedModel');
  const generate = vi.spyOn(service, 'generateText');
  return { service, load, generate };
}

function expectOrdinaryServiceUntouched() {
  expect(ordinaryService.getState).not.toHaveBeenCalled();
  expect(ordinaryService.loadDownloadedModel).not.toHaveBeenCalled();
  expect(ordinaryService.generateText).not.toHaveBeenCalled();
  expect(ordinaryService.listCachedModels).not.toHaveBeenCalled();
}

describe('Explicit hosted Provider service ownership', () => {
  it('keeps two injected service receivers, model states and responses independent', async () => {
    const first = createServiceFixture({ modelId: 'fixture/first', answer: 'first response' });
    const second = createServiceFixture({ modelId: 'fixture/second', answer: 'second response' });
    const firstProvider = createTransformersJsProvider({ service: first.service });
    const secondProvider = createTransformersJsProvider({ service: second.service });
    const firstChunks: string[] = [];
    const secondChunks: string[] = [];
    await firstProvider.chat({ model: 'fixture/first', messages: [], onChunk: ({ chunk }) => firstChunks.push(chunk) });
    expect(second.service.getState()).toEqual({ status: 'idle', activeModelId: undefined });
    await secondProvider.chat({ model: 'fixture/second', messages: [], onChunk: ({ chunk }) => secondChunks.push(chunk) });
    await firstProvider.chat({ model: 'fixture/first', messages: [], onChunk: ({ chunk }) => firstChunks.push(chunk) });
    expect(firstChunks).toEqual(['first response', 'first response']);
    expect(secondChunks).toEqual(['second response']);
    expect(first.load).toHaveBeenCalledOnce();
    expect(second.load).toHaveBeenCalledOnce();
    expect(first.generate).toHaveBeenCalledTimes(2);
    expect(second.generate).toHaveBeenCalledOnce();
    expect(await firstProvider.listModels({})).toEqual(['fixture/first']);
    expect(await secondProvider.listModels({})).toEqual(['fixture/second']);
    expectOrdinaryServiceUntouched();
  });

  it('runs the original tool loop and returns its result to the same injected service', async () => {
    const fixture = createServiceFixture({ modelId: 'fixture/tool', answer: 'unused' });
    const provider = createTransformersJsProvider({ service: fixture.service });
    const call: ToolCall = {
      id: toToolCallId({ raw: 'call_fixed_lookup' }), type: 'function',
      function: { name: 'lookup_fixture', arguments: '{"key":"fixed"}' },
    };
    const requests: ChatMessage[][] = [];
    fixture.generate.mockImplementationOnce(async ({ messages, tools, onToolCalls }) => {
      requests.push(structuredClone(messages));
      expect(tools).toEqual([{ type: 'function', function: {
        name: 'lookup_fixture', description: 'Read a fixed synthetic value.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      } }]);
      onToolCalls({ toolCalls: [call] });
    });
    fixture.generate.mockImplementationOnce(async ({ messages, onChunk }) => {
      requests.push(structuredClone(messages));
      onChunk({ chunk: 'Final answer.' });
    });
    const execute = vi.fn<Tool['execute']>(async ({ args }) => {
      expect(args).toEqual({ key: 'fixed' });
      return { status: 'success', content: 'synthetic result sentinel' };
    });
    const tool: Tool = {
      name: 'lookup_fixture', description: 'Read a fixed synthetic value.',
      parametersSchema: z.object({ key: z.string() }), execute,
    };
    const chunks: string[] = [];
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const input: ChatMessage[] = [{ role: 'user', content: 'Use the fixed tool.' }];
    await provider.chat({
      model: 'fixture/tool', messages: input, tools: [tool],
      onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
    });
    expect(requests).toEqual([
      input,
      [...input, { role: 'assistant', content: '', tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'synthetic result sentinel' }],
    ]);
    expect(input).toEqual([{ role: 'user', content: 'Use the fixed tool.' }]);
    expect(chunks).toEqual(['Final answer.']);
    expect(execute).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith({
      id: call.id, toolName: 'lookup_fixture', modelVisibleArguments: '{"key":"fixed"}',
    });
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      id: call.id, result: { status: 'success', content: 'synthetic result sentinel' },
    });
    expectOrdinaryServiceUntouched();
  });

  it('propagates the injected service rejection without retrying through the ordinary singleton', async () => {
    const fixture = createServiceFixture({ modelId: 'fixture/rejected', answer: 'unused' });
    const error = new Error('Synthetic generation failure');
    fixture.generate.mockRejectedValueOnce(error);
    const provider = createTransformersJsProvider({ service: fixture.service });
    await expect(provider.chat({ model: 'fixture/rejected', messages: [], onChunk: vi.fn() })).rejects.toBe(error);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expectOrdinaryServiceUntouched();
  });
});
