// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode, MessageNode, ToolCall, ToolMessageNode } from '@/01-models/types';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import { createTransformersJsProvider, type TransformersJsProviderService } from './provider-hosted';
import type { TransformersJsInferenceOperation, TransformersJsInferenceScope } from './inference-operation';
import { selectGenerationStrategy } from './generation-strategies';
import { createInferenceEventDelivery } from './worker/inference-event-delivery';
import * as standardToolProtocol from './standard-tool-call-protocol';
import { runProviderTestInferenceOperation } from './provider-inference-test-scope';

type Fragment = { type: 'text'; text: string } | { type: 'control'; token: string };
vi.mock('./index', () => ({ transformersJsService: {} }));
vi.mock('@huggingface/transformers', () => ({ TextStreamer: class {}, StoppingCriteriaList: class {
  push(): void {}
}, Tensor: class {} }));
// This fixture selects synthetic text/control events explicitly; real token
// decoding is covered by each exact-model runtime-output replay, not this mock.
vi.mock('./models/native-protocol-streamer', () => ({ NativeProtocolStreamer: class {
  private readonly onText: ({ text }: { text: string }) => void;
  private readonly onControl: ({ token }: { token: string }) => void;
  constructor({ onText, onControl }: { onText: ({ text }: { text: string }) => void; onControl: ({ token }: { token: string }) => void }) {
    this.onText = onText; this.onControl = onControl;
  }
  emit({ fragment }: { fragment: Fragment }): void {
    switch (fragment.type) {
    case 'text': this.onText({ text: fragment.text }); return;
    case 'control': this.onControl({ token: fragment.token }); return;
    default: { const exhaustive: never = fragment; throw new Error(String(exhaustive)); }
    }
  }
  end(): void {}
} }));
afterEach(() => vi.restoreAllMocks());

const open: Fragment = { type: 'control', token: '<|tool_call_start|>' };
const close: Fragment = { type: 'control', token: '<|tool_call_end|>' };
const eos: Fragment = { type: 'control', token: '<eos>' };
const nativeCall: Fragment[] = [open, { type: 'text', text: '[lookup_weather(city="Tokyo")]' }, close];

// Real public Provider, standard strategy/codec, consumer and common tool loop.
// The service scope and token source are controlled; this is not a lane oracle.
function createPublicationFixture({ outputs, historyEncoding }: {
  outputs: Fragment[][];
  historyEncoding: standardToolProtocol.StandardToolHandling['historyEncoding'];
}) {
  vi.spyOn(standardToolProtocol, 'resolveStandardToolHandling').mockReturnValue({ outputProtocol: 'delimited-pythonic', historyEncoding, preservedDelimiterIds: [] });
  const published: ToolCall[] = [];
  const generate = vi.fn(async ({ streamer }: { streamer: { emit({ fragment }: { fragment: Fragment }): void; end(): void } }) => {
    const output = outputs[generate.mock.calls.length - 1];
    if (output === undefined) throw new Error('Synthetic native plan exhausted');
    for (const fragment of output) streamer.emit({ fragment });
    streamer.end(); return { sequences: [], past_key_values: null };
  });
  const tokens = ['<eos>', '<|tool_call_start|>', '<|tool_call_end|>'];
  const service = {
    runInferenceOperation(args: TransformersJsInferenceOperation) {
      return runProviderTestInferenceOperation({ ...args, service });
    },
    getState: (): ReturnType<TransformersJsProviderService['getState']> => ({ status: 'ready', activeModelId: 'synthetic/content-publication' }),
    loadDownloadedModel: vi.fn(async () => {
      throw new Error('Unexpected Load');
    }),
    listCachedModels: vi.fn(async () => []),
    generateText: vi.fn<TransformersJsProviderService['generateText']>(async () => {
      throw new Error('Legacy output is not used');
    }),
    async generateMessage({ messages, onEvent, params, tools }: Parameters<TransformersJsInferenceScope['generateMessage']>[0] & { signal: AbortSignal }) {
      const delivery = createInferenceEventDelivery({ onEvent, onFailure: () => {} });
      try {
        await selectGenerationStrategy({ modelType: 'synthetic', activeModelId: 'synthetic/content-publication' }).generate({
          model: { generate, config: { model_type: 'synthetic' }, _prepare_generation_config: () => ({ eos_token_id: 0 }) } as never,
          tokenizer: {
            unk_token_id: -1, all_special_ids: [0, 1, 2],
            encode: (text: string) => [tokens.indexOf(text)], decode: (ids: number[]) => tokens[ids[0]!],
            apply_chat_template: (_messages: unknown, options: { tokenize?: boolean }) => options.tokenize === false ? 'plain prompt' : { input_ids: { dims: [1, 2] } },
          } as never,
          messages, params, tools, onChunk: () => {
            throw new Error('Legacy output is not used');
          }, onRawChunk: () => {}, onToolCalls: () => {
            throw new Error('Legacy calls are not used');
          },
          runtimeState: { activeModelId: 'synthetic/content-publication', gemma4Processor: null, qwen3_5Processor: null, gptOssPastKeyValues: null,
            qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
          stoppingCriteria: { reset: () => {}, interrupt: () => {} }, debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
          onGenerationEvent: ({ event }) => {
            if (event.type === 'tool_call') published.push(event.toolCall);
            delivery.enqueue({ event });
          },
        });
      } finally {
        await delivery.finish();
      }
    },
  };
  const provider = createTransformersJsProvider({ service });
  const executions: unknown[] = [];
  const history: MessageNode[] = [{ id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined,
    parts: [{ type: 'text', text: 'Use the weather tool.', completeness: 'complete' }], replies: { items: [] } }];
  const controller = new AbortController();
  return { generate, published, executions, history,
    text: () => history.flatMap(node => node.role === 'assistant' ? node.parts.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join(''),
    run: () => generateChatTurn({ onToolCallDraftsChange: undefined, provider, model: 'synthetic/content-publication', debug: undefined, parameters: undefined, readBinaryObject: undefined, abortController: controller, approvalContext: undefined,
      tools: [{ name: 'lookup_weather', description: 'Fixed weather', parametersSchema: z.object({ city: z.string() }), execute: async ({ args }) => {
        executions.push(structuredClone(args)); return { status: 'success', content: 'Sunny' };
      } }],
      createAssistantMessage: () => {
        const node: AssistantMessageNode = { id: toMessageId({ raw: `a${history.length}` }), role: 'assistant', createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: undefined, parts: [], replies: { items: [] } };
        history.push(node); return node;
      },
      createToolMessage: () => {
        const node: ToolMessageNode = { id: toMessageId({ raw: `t${history.length}` }), role: 'tool', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
        history.push(node); return node;
      },
      buildMessages: ({ excludedMessageId }) => history.filter(node => node.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
      onChange: () => {}, onToolEvent: () => {}, persistToolContent: async ({ text }) => ({ type: 'text', text }), describeError: ({ error }) => error.message,
    }),
  };
}

describe('content history admission before public tool effects', () => {
  it('rejects an unsafe visible prefix before publishing or executing its otherwise valid call', async () => {
    const fixture = createPublicationFixture({ outputs: [[{ type: 'text', text: 'The literal prefix is <' }, { type: 'text', text: '|.' }, ...nativeCall, eos]], historyEncoding: 'verified-content' });
    expect(await fixture.run()).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringMatching(/Content tool history/) }) });
    expect(fixture.published).toEqual([]); expect(fixture.executions).toEqual([]);
    expect(fixture.text()).toBe('The literal prefix is <|.'); expect(fixture.generate).toHaveBeenCalledOnce();
  });
  it('rejects a malformed frame emitted as ordinary text before publishing a later native call', async () => {
    const literal = '<|tool_call_start|>not a call<|tool_call_end|>';
    const fixture = createPublicationFixture({ outputs: [[{ type: 'text', text: literal }, ...nativeCall, eos]], historyEncoding: 'verified-content' });
    expect(await fixture.run()).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringMatching(/Content tool history/) }) });
    expect(fixture.published).toEqual([]); expect(fixture.executions).toEqual([]);
    expect(fixture.text()).toBe(literal); expect(fixture.generate).toHaveBeenCalledOnce();
  });
  it('keeps literal text containing a marker prefix when no call needs history encoding', async () => {
    const fixture = createPublicationFixture({ outputs: [[{ type: 'text', text: 'The literal prefix is <|.' }, eos]], historyEncoding: 'verified-content' });
    expect(await fixture.run()).toEqual({ type: 'finished', next: 'user' });
    expect(fixture.text()).toBe('The literal prefix is <|.'); expect(fixture.published).toEqual([]);
    expect(fixture.executions).toEqual([]); expect(fixture.generate).toHaveBeenCalledOnce();
  });
  it('retains native-template history and executes its admitted call through the common loop', async () => {
    const fixture = createPublicationFixture({ outputs: [[{ type: 'text', text: 'The literal prefix is <|.' }, ...nativeCall, eos], [{ type: 'text', text: 'Done' }, eos]], historyEncoding: 'native-template' });
    expect(await fixture.run()).toEqual({ type: 'finished', next: 'user' });
    expect(fixture.text()).toBe('The literal prefix is <|.Done'); expect(fixture.published).toHaveLength(1);
    expect(fixture.executions).toEqual([{ city: 'Tokyo' }]); expect(fixture.generate).toHaveBeenCalledTimes(2);
    expect(fixture.history.map(node => node.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
  it('keeps an already complete call but does not execute it when later text cannot be re-input', async () => {
    const fixture = createPublicationFixture({ outputs: [[...nativeCall, { type: 'text', text: 'after call' }, eos]], historyEncoding: 'native-template' });
    expect(await fixture.run()).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringMatching(/text after a tool call/) }) });
    expect(fixture.published).toHaveLength(1); expect(fixture.executions).toEqual([]);
    expect(fixture.text()).toBe('after call'); expect(fixture.history.map(node => node.role)).toEqual(['user', 'assistant']);
    expect(fixture.history[1]?.parts).toEqual([expect.objectContaining({ type: 'tool_call' }), expect.objectContaining({ type: 'text', text: 'after call' })]);
  });
  it('does not silently omit unreviewed historical calls when no new tools are declared', async () => {
    vi.spyOn(standardToolProtocol, 'resolveStandardToolHandling').mockReturnValue({ outputProtocol: 'json-tagged', historyEncoding: 'native-template', preservedDelimiterIds: [] });
    const generate = vi.fn(); const apply_chat_template = vi.fn();
    await expect(selectGenerationStrategy({ modelType: 'synthetic', activeModelId: 'synthetic/history' }).generate({
      model: { generate } as never, tokenizer: { apply_chat_template } as never,
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: toToolCallId({ raw: 'c' }), content: 'done' }],
      tools: undefined, params: undefined, onGenerationEvent: () => {},
      onChunk: () => {}, onToolCalls: () => {}, onRawChunk: () => {}, debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
      runtimeState: { activeModelId: 'synthetic/history', gemma4Processor: null, qwen3_5Processor: null, gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, generationStateOwner: {}, qwen3_5SequenceCache: undefined },
      stoppingCriteria: { reset: () => {}, interrupt: () => {} },
    })).rejects.toThrow(/tool history.*adapter/);
    expect(apply_chat_template).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

});
