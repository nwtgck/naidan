// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTransformersJsProvider, type TransformersJsProviderService } from './provider-hosted';
import { selectGenerationStrategy } from './generation-strategies';
import * as standardToolProtocol from './standard-tool-call-protocol';

vi.mock('./index', () => ({ transformersJsService: {} }));
vi.mock('@huggingface/transformers', () => ({
  TextStreamer: class {
    readonly emit: (output: string) => void;
    constructor(_tokenizer: unknown, options: { callback_function(output: string): void }) {
      this.emit = options.callback_function;
    }
  },
  StoppingCriteriaList: class {
    push(): void {}
  },
  Tensor: class {},
}));

// Synthetic native text exercises the real strategy, parser and public Provider
// tool loop. It is not browser evidence, native inference or a Worker replay.
function createPublicationFixture({ outputs, historyEncoding }: {
  outputs: Array<string | string[]>;
  historyEncoding: standardToolProtocol.StandardToolHandling['historyEncoding'];
}) {
  const resolve = vi.spyOn(standardToolProtocol, 'resolveStandardToolHandling').mockReturnValue({
    outputProtocol: 'delimited-pythonic', historyEncoding, preservedDelimiterIds: [],
  });
  const published: unknown[] = [];
  const generate = vi.fn(async ({ streamer }: { streamer: { emit(output: string): void } }) => {
    const output = outputs[generate.mock.calls.length - 1];
    if (output === undefined) throw new Error('Synthetic native plan exhausted');
    for (const chunk of typeof output === 'string' ? [output] : output) streamer.emit(chunk);
    return { sequences: [], past_key_values: null };
  });
  const service: TransformersJsProviderService = {
    getState: () => ({ status: 'ready', activeModelId: 'synthetic/content-publication' }),
    loadDownloadedModel: vi.fn(async () => {
      throw new Error('Unexpected Load');
    }),
    listCachedModels: vi.fn(async () => []),
    async generateText({ messages, onChunk, onToolCalls, params, tools }) {
      await selectGenerationStrategy({ modelType: 'synthetic', activeModelId: 'synthetic/content-publication' }).generate({
        model: { generate } as never,
        tokenizer: {
          apply_chat_template: (_messages: unknown, options: { tokenize?: boolean }) => options.tokenize === false
            ? 'plain prompt' : { input_ids: { dims: [1, 2] } },
        } as never,
        messages, onChunk, onRawChunk: () => {},
        onToolCalls: ({ toolCalls }) => {
          published.push(...toolCalls);
          onToolCalls?.({ toolCalls });
        },
        params, tools,
        runtimeState: {
          activeModelId: 'synthetic/content-publication', gemma4Processor: null, qwen3_5Processor: null,
          gptOssPastKeyValues: null, qwen3_5ConversationState: undefined,
          generationStateOwner: {}, qwen3_5SequenceCache: undefined,
        },
        stoppingCriteria: { reset: () => {}, interrupt: () => {} },
        debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
      });
    },
  };
  return { provider: createTransformersJsProvider({ service }), generate, published, resolve };
}

describe('content history admission before public tool effects', () => {
  it('rejects an unsafe visible prefix before publishing or executing its otherwise valid call', async () => {
    const fixture = createPublicationFixture({
      outputs: [['The literal prefix is <', '|.', '<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>']],
      historyEncoding: 'verified-content',
    });
    const chunks: string[] = [];
    const calls: unknown[] = [];
    const executions: unknown[] = [];
    try {
      await expect(fixture.provider.chat({
        model: 'synthetic/content-publication', messages: [{ role: 'user', content: 'Use the weather tool.' }],
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        onToolCall: call => {
          calls.push({ ...call });
        },
        tools: [{ name: 'lookup_weather', description: 'Fixed weather', parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args)); return { status: 'success', content: 'Sunny' };
          } }],
      })).rejects.toThrow(/Content tool history/);
      expect.soft(fixture.published).toEqual([]);
      expect.soft(calls).toEqual([]);
      expect.soft(executions).toEqual([]);
      expect(chunks.join('')).toBe('The literal prefix is <|.');
      expect(fixture.generate).toHaveBeenCalledOnce();
    } finally {
      fixture.resolve.mockRestore();
    }
  });

  it('rejects a malformed frame emitted as text before publishing a later valid call', async () => {
    const fixture = createPublicationFixture({
      outputs: ['<|tool_call_start|>not a call<|tool_call_end|><|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>'],
      historyEncoding: 'verified-content',
    });
    const chunks: string[] = [];
    const executions: unknown[] = [];
    try {
      await expect(fixture.provider.chat({
        model: 'synthetic/content-publication', messages: [{ role: 'user', content: 'Use the weather tool.' }],
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        tools: [{ name: 'lookup_weather', description: 'Fixed weather', parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args)); return { status: 'success', content: 'Sunny' };
          } }],
      })).rejects.toThrow(/Content tool history/);
      expect.soft(fixture.published).toEqual([]);
      expect.soft(executions).toEqual([]);
      expect(chunks.join('')).toBe('<|tool_call_start|>not a call<|tool_call_end|>');
      expect(fixture.generate).toHaveBeenCalledOnce();
    } finally {
      fixture.resolve.mockRestore();
    }
  });

  it('keeps literal text containing a marker prefix when no tool call needs history encoding', async () => {
    const fixture = createPublicationFixture({ outputs: ['The literal prefix is <|.'], historyEncoding: 'verified-content' });
    const chunks: string[] = [];
    const executions: unknown[] = [];
    try {
      await fixture.provider.chat({
        model: 'synthetic/content-publication', messages: [{ role: 'user', content: 'Describe the prefix.' }],
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        tools: [{ name: 'lookup_weather', description: 'Fixed weather', parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args)); return { status: 'success', content: 'Sunny' };
          } }],
      });
      expect(chunks.join('')).toBe('The literal prefix is <|.');
      expect(fixture.published).toEqual([]);
      expect(executions).toEqual([]);
      expect(fixture.generate).toHaveBeenCalledOnce();
    } finally {
      fixture.resolve.mockRestore();
    }
  });

  it('leaves native-template history handling and its valid tool execution unchanged', async () => {
    const fixture = createPublicationFixture({
      outputs: ['The literal prefix is <|.<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>', 'Done'],
      historyEncoding: 'native-template',
    });
    const chunks: string[] = [];
    const executions: unknown[] = [];
    try {
      await fixture.provider.chat({
        model: 'synthetic/content-publication', messages: [{ role: 'user', content: 'Use the weather tool.' }],
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        tools: [{ name: 'lookup_weather', description: 'Fixed weather', parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args)); return { status: 'success', content: 'Sunny' };
          } }],
      });
      expect(chunks.join('')).toBe('The literal prefix is <|.Done');
      expect(fixture.published).toHaveLength(1);
      expect(executions).toEqual([{ city: 'Tokyo' }]);
      expect(fixture.generate).toHaveBeenCalledTimes(2);
    } finally {
      fixture.resolve.mockRestore();
    }
  });
});
