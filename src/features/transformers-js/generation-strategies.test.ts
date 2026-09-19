import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, LmParameters } from "@/01-models/types";
import { toToolCallId } from '@/01-models/ids';
import type { GenerationCaptureCall } from "./worker/generation-capture";
import * as standardToolProtocol from './standard-tool-call-protocol';
import type { WorkerToolJsonObject } from './types';

vi.mock("@huggingface/transformers", () => ({
  TextStreamer: class {
    readonly emit: (output: string) => void;
    // Mirrors the upstream constructor used by the actual strategy.
    constructor(_tokenizer: unknown, options: { callback_function: (output: string) => void }) {
      this.emit = options.callback_function;
    }
  },
  StoppingCriteriaList: class {
    push(): void {}
  },
  Tensor: class {},
  RawImage: { read: vi.fn(async () => ({ width: 1, height: 1, data: Uint8Array.of(0, 0, 0) })) },
}));

import {
  selectGenerationStrategy,
  type GenerationStrategyObservationSink,
  type GenerationInvocationObservation,
  type WorkerGenerationRuntimeState,
} from "./generation-strategies";

async function pendingGptPublication() {
  const gpt = await import('./models/gpt-oss');
  const completion = Promise.withResolvers<unknown>();
  const generate = vi.spyOn(gpt, 'generateGptOss').mockReturnValue(completion.promise);
  const state: WorkerGenerationRuntimeState = {
    activeModelId: 'synthetic/gpt', gemma4Processor: null, qwen3_5Processor: null,
    gptOssPastKeyValues: { previous: true }, qwen3_5ConversationState: undefined,
    generationStateOwner: {}, qwen3_5SequenceCache: undefined,
  };
  const operation = selectGenerationStrategy({ modelType: 'gpt_oss', activeModelId: 'synthetic/gpt' }).generate({
    model: {} as never, tokenizer: {} as never, messages: [], onChunk: vi.fn(), onRawChunk: vi.fn(), onToolCalls: vi.fn(),
    params: undefined, tools: undefined, runtimeState: state, stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() },
    debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
  });
  return { state, completion, generate, operation };
}

describe('shared generation state publication ownership', () => {
  it('does not republish a GPT cache after its generation owner was revoked by reset', async () => {
    const fixture = await pendingGptPublication();
    try {
      fixture.state.generationStateOwner = {};
      fixture.state.gptOssPastKeyValues = null;
      fixture.completion.resolve({ stale: true });
      await fixture.operation;
      expect(fixture.state.gptOssPastKeyValues).toBeNull();
    } finally {
      fixture.generate.mockRestore();
    }
  });

  it('does not overwrite a later request GPT cache when an older generation resolves', async () => {
    const fixture = await pendingGptPublication();
    const newer = { newer: true };
    try {
      fixture.state.generationStateOwner = {};
      fixture.state.gptOssPastKeyValues = newer;
      fixture.completion.resolve({ stale: true });
      await fixture.operation;
      expect(fixture.state.gptOssPastKeyValues).toBe(newer);
    } finally {
      fixture.generate.mockRestore();
    }
  });
});

describe('verified content-route tool publication', () => {
  it.each([
    { name: 'multiple framed calls', output: '<|tool_call_start|>[lookup_weather(city="Tokyo"), lookup_weather(city="Osaka")]<|tool_call_end|>', rejected: true, expectedText: '', expectedCalls: 0 },
    { name: 'bare bracket text', output: '[lookup_weather(city="Tokyo")]', rejected: false, expectedText: '[lookup_weather(city="Tokyo")]', expectedCalls: 0 },
    { name: 'one complete framed call', output: '<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>', rejected: false, expectedText: '', expectedCalls: 1 },
  ])('checks $name before publishing executable calls', async ({ output, rejected, expectedText, expectedCalls }) => {
    // Synthetic syntax controls, not captured model inference. The real parser
    // and strategy publication ordering are the boundary under test here.
    const resolve = vi.spyOn(standardToolProtocol, 'resolveStandardToolHandling').mockReturnValue({
      outputProtocol: 'delimited-pythonic', historyEncoding: 'verified-content', preservedDelimiterIds: [10, 11],
    });
    const chunks: string[] = [];
    const published: unknown[] = [];
    const generate = vi.fn(async ({ streamer }: { streamer: { emit(text: string): void } }) => {
      streamer.emit(output); return { sequences: [], past_key_values: null };
    });
    try {
      const operation = selectGenerationStrategy({ modelType: 'synthetic', activeModelId: 'synthetic/content' }).generate({
        model: { generate } as never,
        tokenizer: { all_special_ids: [7, 10, 11], decode: () => '', apply_chat_template: (_messages: unknown, options: { tokenize?: boolean }) => options.tokenize === false ? 'plain prompt' : { input_ids: { dims: [1, 2] } } } as never,
        messages: [{ role: 'user', content: 'Use a tool.' }],
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        }, onRawChunk: vi.fn(),
        onToolCalls: ({ toolCalls }) => {
          published.push(...toolCalls);
        },
        params: explicitParameters,
        tools: [{ type: 'function', function: { name: 'lookup_weather', description: 'Fixed tool', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
        runtimeState: { activeModelId: 'synthetic/content', gemma4Processor: null, qwen3_5Processor: null, gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
        stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
      });
      if (rejected) await expect(operation).rejects.toThrow('Content tool history does not support multiple calls');
      else await operation;
      expect(published).toHaveLength(expectedCalls);
      expect(chunks.join('')).toBe(expectedText);
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      resolve.mockRestore();
    }
  });
});

describe('Qwen prompt-owned reasoning delivery', () => {
  const openPrompt = `\
<|im_start|>assistant
<think>
`;
  const closedPrompt = `\
<|im_start|>assistant
<think>

</think>

`;
  it.each([
    { name: 'default native open prompt', effort: undefined, prompt: openPrompt, output: ['Reason', '</think>Answer'], expected: '<think>Reason</think>Answer' },
    { name: 'enabled native open prompt', effort: 'low', prompt: openPrompt, output: ['Reason', '</think>Answer'], expected: '<think>Reason</think>Answer' },
    { name: 'disabled native closed prompt', effort: 'none', prompt: closedPrompt, output: ['Answer'], expected: 'Answer' },
    { name: 'default native closed prompt', effort: undefined, prompt: closedPrompt, output: ['Answer'], expected: 'Answer' },
    { name: 'enabled template without an open suffix', effort: 'high', prompt: '<|im_start|>assistant\n', output: ['Answer'], expected: 'Answer' },
    { name: 'already generated split opening tag', effort: 'medium', prompt: openPrompt, output: ['<thi', 'nk>Reason', '</think>Answer'], expected: '<think>Reason</think>Answer' },
    { name: 'no native output', effort: undefined, prompt: openPrompt, output: ['', ''], expected: '' },
    { name: 'partial generated opening at stream end', effort: undefined, prompt: openPrompt, output: ['<thi'], expected: '<think><thi' },
    { name: 'literal user suffix is not an assistant thinking prefix', effort: undefined, prompt: `\
<|im_start|>user
literal <think>
`, output: ['Answer'], expected: 'Answer' },
    { name: 'unknown custom template suffix is not inferred', effort: 'high', prompt: 'custom user text <think>\n', output: ['Answer'], expected: 'Answer' },
  ] satisfies Array<{ name: string; effort: LmParameters['reasoning']['effort']; prompt: string; output: string[]; expected: string }>)('$name', async ({ effort, prompt, output, expected }) => {
    const chunks: string[] = [];
    const tools: unknown[] = [];
    const processor = Object.assign(vi.fn(async () => ({ input_ids: { dims: [1, 2] } })), { batch_decode: vi.fn(() => []) });
    const apply_chat_template = vi.fn(() => prompt);
    const generate = vi.fn(async ({ streamer }: { streamer: { emit: (text: string) => void } }) => {
      for (const text of output) streamer.emit(text);
      return { past_key_values: null, sequences: [] };
    });
    await selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/qwen' }).generate({
      model: { generate, sessions: {} } as never, tokenizer: { apply_chat_template } as never,
      messages: [{ role: 'user', content: 'A fixed prompt.' }],
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onRawChunk: vi.fn(), onToolCalls: ({ toolCalls }) => {
        tools.push(...toolCalls);
      },
      params: { ...explicitParameters, reasoning: { effort } }, tools: undefined,
      runtimeState: { activeModelId: 'synthetic/qwen', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
    });
    expect(chunks.join('')).toBe(expected);
    if (expected === '') expect(chunks).toEqual([]);
    expect(tools).toEqual([]);
    expect(apply_chat_template).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ input_ids: { dims: [1, 2] }, past_key_values: null }));
  });

  it('does not publish an empty thinking opener for tool syntax without assistant text', async () => {
    const chunks: string[] = [];
    const calls: unknown[] = [];
    const processor = Object.assign(vi.fn(async () => ({ input_ids: { dims: [1, 2] } })), { batch_decode: vi.fn(() => []) });
    await selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/qwen' }).generate({
      model: { sessions: {}, generate: async ({ streamer }: { streamer: { emit: (text: string) => void } }) => {
        streamer.emit('<tool_call><function=lookup_weather><parameter=city>Tokyo</parameter></function></tool_call>');
        return { past_key_values: null, sequences: [] };
      } } as never,
      tokenizer: { apply_chat_template: () => openPrompt } as never, messages: [{ role: 'user', content: 'Weather.' }],
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onRawChunk: vi.fn(), onToolCalls: ({ toolCalls }) => {
        calls.push(...toolCalls);
      },
      params: explicitParameters, tools: undefined,
      runtimeState: { activeModelId: 'synthetic/qwen', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
    });
    expect(chunks).toEqual([]);
    expect(calls).toEqual([{ id: expect.any(String), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }]);
  });

  it.each(['tool-continuation', 'image'] as const)('restores the current %s prompt opening without changing prepared inputs', async kind => {
    const chunks: string[] = [];
    const messages: ChatMessage[] = kind === 'tool-continuation' ? [
      { role: 'user', content: 'Use the weather tool for Tokyo.' },
      { role: 'assistant', content: '', tool_calls: [{ id: toToolCallId({ raw: 'fixed-call' }), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: toToolCallId({ raw: 'fixed-call' }), content: '{"temperatureC":20}' },
    ] : [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixed-platform-input' } }] }];
    const prepared = { input_ids: { dims: [1, 2] }, ...(kind === 'image' ? { pixel_values: { dims: [1, 3, 1, 1] }, image_grid_thw: { dims: [1, 3] } } : {}) };
    const processor = Object.assign(vi.fn(async (_prompt: string, _images?: unknown[]) => prepared), { batch_decode: vi.fn(() => []) });
    const apply_chat_template = vi.fn(() => openPrompt);
    const generate = vi.fn(async ({ streamer }: { streamer: { emit: (text: string) => void } }) => {
      streamer.emit('Reason</think>Answer'); return { past_key_values: null, sequences: [] };
    });
    await selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/qwen' }).generate({
      model: { generate, sessions: { vision_encoder: {} } } as never, tokenizer: { apply_chat_template } as never, messages,
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onRawChunk: vi.fn(), onToolCalls: vi.fn(), params: explicitParameters,
      tools: kind === 'tool-continuation' ? [{ type: 'function', function: { name: 'lookup_weather', description: 'Fixed tool', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] : undefined,
      runtimeState: { activeModelId: 'synthetic/qwen', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
    });
    expect(chunks.join('')).toBe('<think>Reason</think>Answer');
    expect(apply_chat_template).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledOnce();
    expect(processor.mock.calls[0]?.[0]).toBe(openPrompt);
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...prepared, past_key_values: null }));
  });
});

describe('schema-bound Qwen XML arguments, not captured model output', () => {
  it.each<{ name: string; schema: WorkerToolJsonObject; value: string; expected: unknown }>([
    { name: 'JSON-looking string', schema: { type: 'string' }, value: '{"city":"Tokyo"}', expected: '{"city":"Tokyo"}' },
    { name: 'array-looking string', schema: { type: 'string' }, value: '[1,2]', expected: '[1,2]' },
    { name: 'boolean-looking string', schema: { type: 'string' }, value: 'true', expected: 'true' },
    { name: 'object', schema: { type: 'object' }, value: '{"city":"Tokyo"}', expected: { city: 'Tokyo' } },
    { name: 'array', schema: { type: 'array' }, value: '[1,2]', expected: [1, 2] },
  ])('$name', async ({ schema, value, expected }) => {
    const chunks: string[] = [];
    const calls: Array<{ function: { arguments: string } }> = [];
    const generate = vi.fn(async ({ streamer }: { streamer: { emit(text: string): void } }) => {
      streamer.emit(`<tool_call><function=write_file><parameter=content>${value}</parameter></function></tool_call>`);
      return { past_key_values: null, sequences: [] };
    });
    const processor = Object.assign(vi.fn(async () => ({ input_ids: { dims: [1, 2] } })), { batch_decode: vi.fn(() => []) });
    const operation = selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/qwen' }).generate({
      model: { generate, sessions: {} } as never,
      tokenizer: { apply_chat_template: () => 'Explicit synthetic prompt.' } as never,
      messages: [{ role: 'user', content: 'Use the supplied tool.' }],
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onRawChunk: vi.fn(),
      onToolCalls: ({ toolCalls }) => {
        calls.push(...toolCalls);
      },
      params: explicitParameters,
      tools: [{ type: 'function', function: { name: 'write_file', description: 'A synthetic schema control.', parameters: { type: 'object', properties: { content: schema } } } }],
      runtimeState: { activeModelId: 'synthetic/qwen', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
    });
    await operation;
    expect(generate).toHaveBeenCalledOnce();
    expect(chunks).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ content: expected });
  });

  it('rejects ambiguous string-or-object XML before publishing a tool call', async () => {
    const calls: unknown[] = [];
    const processor = Object.assign(vi.fn(async () => ({ input_ids: { dims: [1, 2] } })), { batch_decode: vi.fn(() => []) });
    const generate = vi.fn(async ({ streamer }: { streamer: { emit(text: string): void } }) => {
      streamer.emit('<tool_call><function=write_file><parameter=content>{"city":"Tokyo"}</parameter></function></tool_call>');
      return { past_key_values: null, sequences: [] };
    });
    await expect(selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/qwen' }).generate({
      model: { generate, sessions: {} } as never,
      tokenizer: { apply_chat_template: () => 'Explicit synthetic prompt.' } as never,
      messages: [{ role: 'user', content: 'Use the supplied tool.' }],
      onChunk: () => {}, onRawChunk: () => {}, onToolCalls: ({ toolCalls }) => {
        calls.push(...toolCalls);
      },
      params: explicitParameters,
      tools: [{ type: 'function', function: { name: 'write_file', description: 'Synthetic ambiguous schema.', parameters: {
        type: 'object', properties: { content: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
      } } }],
      runtimeState: { activeModelId: 'synthetic/qwen', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink: undefined, generationCapture: undefined,
    })).rejects.toThrow('Ambiguous Qwen XML parameter type');
    expect(calls).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe("generation strategy observation isolation", () => {
  it('uses one full native Qwen render even when old message-count eligibility suggests continuation', async () => {
    const full = 'native full conversation including its own default preamble';
    const processor = Object.assign(vi.fn(async () => ({ input_ids: { dims: [1, 2] } })), { batch_decode: vi.fn(() => ['result']) });
    const apply_chat_template = vi.fn(() => full);
    const generate = vi.fn(async () => ({ past_key_values: null, sequences: [] }));
    const observationSink: GenerationStrategyObservationSink = {
      onFullConversationInputPrepared: vi.fn(), onGenerateStart: vi.fn(), onGenerateInvocation: vi.fn(), onGenerateComplete: vi.fn(),
    };
    await selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: 'synthetic/model' }).generate({
      model: { generate } as never, tokenizer: { apply_chat_template } as never,
      messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'next' }],
      onChunk: vi.fn(), onRawChunk: vi.fn(), onToolCalls: vi.fn(), params: explicitParameters, tools: undefined,
      runtimeState: {
        activeModelId: 'synthetic/model', gemma4Processor: null, qwen3_5Processor: processor,
        gptOssPastKeyValues: null,
        qwen3_5ConversationState: { modelId: 'synthetic/model', messageCount: 1 },
        generationStateOwner: {}, qwen3_5SequenceCache: undefined,
      },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() }, debugLog: vi.fn(), observationSink, generationCapture: undefined,
    });
    expect(apply_chat_template).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledExactlyOnceWith(full);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ past_key_values: null }));
  });

  it("does not let diagnostic observation failures change standard Production generation", async () => {
    const generate = vi.fn().mockResolvedValue({ past_key_values: null, sequences: [] });
    const applyChatTemplate = vi.fn().mockReturnValue({
      input_ids: { data: BigInt64Array.from([10n, 11n]) },
    });
    const observationSink: GenerationStrategyObservationSink = {
      onFullConversationInputPrepared: vi.fn(() => {
        throw new Error("full input observer failed");
      }),
      onGenerateStart: vi.fn(() => {
        throw new Error("generate start observer failed");
      }),
      onGenerateInvocation: vi.fn(() => {
        throw new Error("generate invocation observer failed");
      }),
      onGenerateComplete: vi.fn(() => {
        throw new Error("generate complete observer failed");
      }),
    };

    const strategy = selectGenerationStrategy({
      modelType: "fixture",
      activeModelId: "org/model",
    });

    await expect(strategy.generate({
      model: { generate } as never,
      tokenizer: { apply_chat_template: applyChatTemplate } as never,
      messages: [{ role: "user", content: "hello" }],
      onChunk: vi.fn(),
      onRawChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: {
        temperature: undefined,
        topP: undefined,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: undefined },
      },
      tools: undefined,
      runtimeState: {
        activeModelId: "org/model",
        gemma4Processor: null,
        qwen3_5Processor: null,
        gptOssPastKeyValues: null,

        qwen3_5ConversationState: undefined,
        generationStateOwner: {}, qwen3_5SequenceCache: undefined,
      },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() },
      debugLog: vi.fn(),
      observationSink,
      generationCapture: undefined,
    })).resolves.toBeUndefined();

    expect(applyChatTemplate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledOnce();
    expect(observationSink.onFullConversationInputPrepared).toHaveBeenCalledOnce();
    expect(observationSink.onGenerateStart).toHaveBeenCalledOnce();
    expect(observationSink.onGenerateInvocation).toHaveBeenCalledOnce();
    expect(observationSink.onGenerateComplete).toHaveBeenCalledOnce();
  });
});

const explicitParameters: LmParameters = {
  temperature: 0, topP: 1, maxCompletionTokens: 16,
  presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined,
  reasoning: { effort: undefined },
};

function createInvocationFixture({ inputs, params, modelConfig }: {
  inputs: Record<string, unknown>; params: LmParameters | undefined; modelConfig: unknown;
}) {
  const events: string[] = [];
  const nativeResult = { past_key_values: null, sequences: [] };
  const generate = vi.fn<(options: Record<string, unknown>) => Promise<typeof nativeResult>>(() => {
    events.push('native');
    return Promise.resolve(nativeResult);
  });
  const model = { config: modelConfig, get generate() {
    events.push('native-method'); return generate;
  } };
  const sink: GenerationStrategyObservationSink = {
    onFullConversationInputPrepared: vi.fn(() => {
      events.push('full-input');
    }),
    onGenerateStart: vi.fn(() => {
      events.push('start');
    }),
    onGenerateInvocation: vi.fn(() => {
      events.push('invocation');
    }),
    onGenerateComplete: vi.fn(() => {
      events.push('complete');
    }),
  };
  function run({ observationSink, generationCapture }: { observationSink: GenerationStrategyObservationSink | undefined; generationCapture: GenerationCaptureCall | undefined }) {
    return selectGenerationStrategy({ modelType: 'fixture', activeModelId: 'org/model' }).generate({
      model: model as never,
      tokenizer: { apply_chat_template: vi.fn(() => inputs) } as never,
      messages: [{ role: 'user', content: 'Fixed synthetic invocation input.' }],
      onChunk: () => {
        events.push('chunk');
      },
      onRawChunk: () => {
        events.push('raw-chunk');
      },
      onToolCalls: vi.fn(), params, tools: undefined,
      runtimeState: {
        activeModelId: 'org/model', gemma4Processor: null, qwen3_5Processor: null,
        gptOssPastKeyValues: null, qwen3_5ConversationState: undefined,
        generationStateOwner: {}, qwen3_5SequenceCache: undefined,
      },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() },
      debugLog: vi.fn(), observationSink, generationCapture,
    });
  }
  return { events, nativeResult, generate, model, sink, run };
}

describe('actual native invocation observation; isolated strategy boundary', () => {
  it('contains a failing capture initializer without adding observation work or changing native success', async () => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] } }, params: explicitParameters, modelConfig: {} });
    const beginInvocation = vi.fn(() => {
      throw new Error('Synthetic recorder failure');
    });
    const capture: GenerationCaptureCall = { beginInvocation, recordChunk: vi.fn(), finish: vi.fn() };
    await expect(fixture.run({ observationSink: undefined, generationCapture: capture })).resolves.toBeUndefined();
    expect(beginInvocation).toHaveBeenCalledOnce();
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual(['native-method', 'native']);
    expect(fixture.sink.onFullConversationInputPrepared).not.toHaveBeenCalled();
  });

  it('contains failing capture recorders while preserving the original native rejection and receiver', async () => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] } }, params: explicitParameters, modelConfig: {} });
    const failure = new Error('Synthetic native failure');
    fixture.generate.mockRejectedValueOnce(failure);
    const failRecord = vi.fn(() => {
      throw new Error('Synthetic recording failure');
    });
    const capture: GenerationCaptureCall = {
      beginInvocation: () => ({ recordInputs: failRecord, recordSettings: failRecord, recordSequence: failRecord, recordChunk: failRecord, recordNativeCall: failRecord, setNativeStreamAvailability: failRecord, recordNativeStream: failRecord }),
      recordChunk: vi.fn(), finish: vi.fn(),
    };
    await expect(fixture.run({ observationSink: undefined, generationCapture: capture })).rejects.toBe(failure);
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.generate.mock.contexts[0]).toBe(fixture.model);
    expect(failRecord).toHaveBeenCalled();
  });

  it('records the requested 16 separately from actual clamped 3 before one native call with the original receiver', async () => {
    const inputIds = { dims: [1, 7], data: BigInt64Array.of(1n, 2n, 3n, 4n, 5n, 6n, 7n) };
    const inputs: Record<string, unknown> = { input_ids: inputIds };
    const fixture = createInvocationFixture({ inputs, params: explicitParameters, modelConfig: { max_position_embeddings: 10 } });
    Object.defineProperty(inputs, 'extra_input', { enumerable: true, get() {
      fixture.events.push('input-getter'); return inputIds;
    } });
    let observed: GenerationInvocationObservation | undefined;
    fixture.sink.onGenerateInvocation = vi.fn(({ observation }) => {
      observed = observation;
      fixture.events.push('invocation');
      queueMicrotask(() => {
        fixture.events.push('observer-microtask');
      });
    });
    fixture.generate.mockImplementation(options => {
      fixture.events.push('native');
      const streamer = options.streamer as { emit(output: string): void };
      streamer.emit('synthetic ');
      return Promise.resolve(fixture.nativeResult);
    });
    const pending = fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    expect(fixture.events).toEqual(['full-input', 'start', 'native-method', 'input-getter', 'invocation', 'native', 'raw-chunk', 'chunk']);
    await pending;
    expect(fixture.events).toEqual(['full-input', 'start', 'native-method', 'input-getter', 'invocation', 'native', 'raw-chunk', 'chunk', 'observer-microtask', 'complete']);
    expect(observed).toEqual({
      requested: {
        maxCompletionTokens: { status: 'value', value: 16 },
        temperature: { status: 'value', value: 0 }, topP: { status: 'value', value: 1 },
      },
      budget: { maxNewTokens: 3, source: 'explicit', contextLimit: 10, promptTokenCount: 7, pastTokenCount: 0, usedContextTokenCount: 7 },
      kwargs: {
        keys: {
          status: 'complete', totalCount: 10,
          values: ['input_ids', 'extra_input', 'past_key_values', 'max_new_tokens', 'temperature', 'top_p', 'do_sample', 'streamer', 'stopping_criteria', 'return_dict_in_generate'],
          incompleteReasons: [],
        },
        maxNewTokens: { status: 'value', value: 3 }, temperature: { status: 'value', value: 0 },
        topP: { status: 'value', value: 1 }, doSample: { status: 'value', value: false }, returnDictInGenerate: { status: 'value', value: true },
      },
    });
    expect(fixture.generate).toHaveBeenCalledOnce();
    expect(fixture.generate.mock.contexts[0]).toBe(fixture.model);
    expect(fixture.generate.mock.calls[0]?.[0]).toMatchObject({ input_ids: inputIds, extra_input: inputIds, max_new_tokens: 3 });
    expect(fixture.generate.mock.calls[0]?.[0].input_ids).toBe(inputIds);
    expect(fixture.sink.onGenerateComplete).toHaveBeenCalledExactlyOnceWith({ result: fixture.nativeResult });
  });

  it.each([
    { name: 'omitted', addition: {}, expected: { status: 'omitted' }, ownsKey: false },
    { name: 'own undefined', addition: { max_new_tokens: undefined }, expected: { status: 'undefined' }, ownsKey: true },
    { name: 'own null', addition: { max_new_tokens: null }, expected: { status: 'null' }, ownsKey: true },
    { name: 'input-supplied value', addition: { max_new_tokens: 5 }, expected: { status: 'value', value: 5 }, ownsKey: true },
  ])('distinguishes $name native max_new_tokens from Transformers defaults without adding a key', async ({ addition, expected, ownsKey }) => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] }, ...addition }, params: undefined, modelConfig: {} });
    await fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    const observed = vi.mocked(fixture.sink.onGenerateInvocation).mock.calls[0]?.[0].observation;
    expect(observed?.budget).toEqual({ maxNewTokens: undefined, source: 'transformers-default', contextLimit: undefined, promptTokenCount: 2, pastTokenCount: 0, usedContextTokenCount: 2 });
    expect(observed?.requested).toEqual({ maxCompletionTokens: { status: 'omitted' }, temperature: { status: 'omitted' }, topP: { status: 'omitted' } });
    expect(observed?.kwargs.maxNewTokens).toEqual(expected);
    expect(observed?.kwargs.temperature).toEqual({ status: 'value', value: 0.6 });
    expect(observed?.kwargs.topP).toEqual({ status: 'value', value: 0.9 });
    expect(observed?.kwargs.doSample).toEqual({ status: 'value', value: true });
    expect(Object.hasOwn(fixture.generate.mock.calls[0]![0], 'max_new_tokens')).toBe(ownsKey);
    expect(observed?.kwargs.keys.values.includes('max_new_tokens')).toBe(ownsKey);
  });

  it.each([NaN, Infinity, -Infinity])('marks non-finite setting %s unrecorded without changing the native value', async value => {
    const fixture = createInvocationFixture({
      inputs: { input_ids: { dims: [1, 2] }, max_new_tokens: value },
      params: { ...explicitParameters, maxCompletionTokens: undefined, temperature: value, topP: value },
      modelConfig: {},
    });
    await fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    const observed = vi.mocked(fixture.sink.onGenerateInvocation).mock.calls[0]?.[0].observation;
    expect(observed?.requested.maxCompletionTokens).toEqual({ status: 'undefined' });
    expect(observed?.requested.temperature).toEqual({ status: 'not-recorded', reason: 'non-finite-number' });
    expect(observed?.requested.topP).toEqual({ status: 'not-recorded', reason: 'non-finite-number' });
    expect(observed?.kwargs.maxNewTokens).toEqual({ status: 'not-recorded', reason: 'non-finite-number' });
    expect(observed?.kwargs.temperature).toEqual({ status: 'not-recorded', reason: 'non-finite-number' });
    expect(observed?.kwargs.topP).toEqual({ status: 'not-recorded', reason: 'non-finite-number' });
    expect(fixture.generate.mock.calls[0]?.[0].max_new_tokens).toBe(value);
    expect(fixture.generate.mock.calls[0]?.[0].temperature).toBe(value);
    expect(fixture.generate.mock.calls[0]?.[0].top_p).toBe(value);
  });

  it('does not invoke native or report an invocation when the context is full, retaining the earlier start phase', async () => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 10] } }, params: explicitParameters, modelConfig: { max_position_embeddings: 10 } });
    await expect(fixture.run({ observationSink: fixture.sink, generationCapture: undefined })).rejects.toThrow('Generation cannot start because the model context is full (10/10 tokens).');
    expect(fixture.events).toEqual(['full-input', 'start']);
    expect(fixture.sink.onGenerateInvocation).not.toHaveBeenCalled();
    expect(fixture.sink.onGenerateComplete).not.toHaveBeenCalled();
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it('keeps the frozen snapshot detached from later native mutation and rejects observer writes without freezing live objects', async () => {
    const inputs = { input_ids: { dims: [1, 2] } };
    const params = { ...explicitParameters };
    const fixture = createInvocationFixture({ inputs, params, modelConfig: {} });
    let observed: GenerationInvocationObservation | undefined;
    const mutations: boolean[] = [];
    fixture.sink.onGenerateInvocation = ({ observation }) => {
      observed = observation;
      mutations.push(Reflect.set(observation.budget, 'maxNewTokens', 999));
      mutations.push(Reflect.set(observation.kwargs.temperature, 'value', 999));
      mutations.push(Reflect.set(observation.requested.maxCompletionTokens, 'value', 999));
      mutations.push(Reflect.set(observation.kwargs.keys.values, '0', 'changed'));
      mutations.push(Reflect.set(observation.kwargs.keys.incompleteReasons, '0', 'changed'));
      mutations.push(Reflect.set(observation, 'kwargs', {}));
    };
    fixture.generate.mockImplementation(options => {
      options.max_new_tokens = 4;
      params.maxCompletionTokens = 3;
      inputs.input_ids.dims[1] = 99;
      return Promise.resolve(fixture.nativeResult);
    });
    await fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    expect(mutations).toEqual([false, false, false, false, false, false]);
    expect(observed?.budget.maxNewTokens).toBe(16);
    expect(observed?.requested.maxCompletionTokens).toEqual({ status: 'value', value: 16 });
    expect(observed?.kwargs.maxNewTokens).toEqual({ status: 'value', value: 16 });
    expect(observed?.budget.promptTokenCount).toBe(2);
    expect(fixture.generate.mock.calls[0]?.[0].max_new_tokens).toBe(4);
    expect(inputs.input_ids.dims).toEqual([1, 99]);
  });

  it('records a requested accessor as unrecorded without executing it again', async () => {
    const getter = vi.fn(() => 16);
    const params = { ...explicitParameters };
    Object.defineProperty(params, 'maxCompletionTokens', { get: getter });
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] } }, params, modelConfig: {} });
    await fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    expect(getter).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.sink.onGenerateInvocation).mock.calls[0]?.[0].observation.requested.maxCompletionTokens)
      .toEqual({ status: 'not-recorded', reason: 'accessor' });
    expect(fixture.generate.mock.calls[0]?.[0].max_new_tokens).toBe(16);
  });

  it('bounds unknown key capture and marks symbol and overlong keys incomplete without changing native kwargs', async () => {
    const symbol = Symbol('synthetic key');
    const longKey = 'k'.repeat(129);
    const inputs = { input_ids: { dims: [1, 2] }, [longKey]: 1, ...Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`extra_${index}`, index])), [symbol]: 2 };
    const fixture = createInvocationFixture({ inputs, params: explicitParameters, modelConfig: {} });
    await fixture.run({ observationSink: fixture.sink, generationCapture: undefined });
    const keys = vi.mocked(fixture.sink.onGenerateInvocation).mock.calls[0]?.[0].observation.kwargs.keys;
    expect(keys?.status).toBe('incomplete');
    expect(keys?.totalCount).toBe(81);
    expect(keys?.values).toHaveLength(64);
    expect(keys?.values.every(key => key.length <= 128)).toBe(true);
    expect(keys?.incompleteReasons).toEqual(['key-length-limit', 'key-count-limit', 'symbol-key']);
    expect(fixture.generate.mock.calls[0]?.[0][longKey]).toBe(1);
    expect(Reflect.get(fixture.generate.mock.calls[0]![0], symbol)).toBe(2);
    expect(fixture.generate.mock.calls[0]?.[0].extra_69).toBe(69);
  });

  it('preserves the same native success when the invocation sink throws', async () => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] } }, params: explicitParameters, modelConfig: {} });
    const completed: unknown[] = [];
    let invocations = 0;
    fixture.sink.onGenerateInvocation = () => {
      ++invocations; throw new Error('Synthetic observer failure');
    };
    fixture.sink.onGenerateComplete = ({ result }) => {
      completed.push(result);
    };
    await expect(fixture.run({ observationSink: fixture.sink, generationCapture: undefined })).resolves.toBeUndefined();
    await expect(fixture.run({ observationSink: undefined, generationCapture: undefined })).resolves.toBeUndefined();
    expect(invocations).toBe(1);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(completed).toEqual([fixture.nativeResult]);
    expect(completed[0]).toBe(fixture.nativeResult);
  });

  it('preserves the exact native rejection when the invocation sink throws', async () => {
    const fixture = createInvocationFixture({ inputs: { input_ids: { dims: [1, 2] } }, params: explicitParameters, modelConfig: {} });
    const failure = new Error('Original synthetic native failure');
    let invocations = 0;
    fixture.sink.onGenerateInvocation = () => {
      ++invocations; throw new Error('Synthetic observer failure');
    };
    fixture.generate.mockRejectedValue(failure);
    await expect(fixture.run({ observationSink: fixture.sink, generationCapture: undefined })).rejects.toBe(failure);
    await expect(fixture.run({ observationSink: undefined, generationCapture: undefined })).rejects.toBe(failure);
    expect(invocations).toBe(1);
    expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.sink.onGenerateComplete).not.toHaveBeenCalled();
  });
});
