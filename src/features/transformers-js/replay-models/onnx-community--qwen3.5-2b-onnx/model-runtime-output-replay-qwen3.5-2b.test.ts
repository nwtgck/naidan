// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFor, start, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import { createQwen3_5Generation, qwen3_5ProtocolTokens } from '@/features/transformers-js/models/qwen3_5-generation';
import { createInferenceGeneration } from '@/features/transformers-js/create-inference-generation';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { prepareInferenceRequest } from '@/features/transformers-js/message-projection';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { buildQwen3_5Prompt } from '@/features/transformers-js/models/qwen3_5';
import { toChatId, toMessageId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type AssistantMessageNode, type ChatContent, type ToolMessageNode, type UserMessageNode } from '@/01-models/types';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { GenerationStrategy } from '@/features/transformers-js/generation-strategies';
import type { NativeProtocolStreamer as NativeStreamerType } from '@/features/transformers-js/models/native-protocol-streamer';

type Context = Parameters<GenerationStrategy['generate']>[0];
const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
// Synthetic output controls use the model's original tokenizer, not recorded inference.
installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers'); vi.resetModules();
});
function assistant(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a1' }), role: 'assistant', parts: [], createdAt: 1,
    modelId, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

describe('Qwen3.5 2B original tokenizer and native output controls', () => {
  it.each(['single', 'batch'] as const)('distinguishes atomic added delimiters from ordinary text with %s delivery', async delivery => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = (await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    })) as unknown as Context['tokenizer'];
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    // These delimiters are atomic added tokens, but not special=true. A generic
    // all_special_ids filter alone cannot identify this model's protocol.
    for (const marker of qwen3_5ProtocolTokens) {
      const ids = tokenizer.encode(marker, { add_special_tokens: false });
      expect(ids).toHaveLength(1); expect(tokenizer.all_special_ids.map(Number)).not.toContain(Number(ids[0]));
    }
    const encode = ({ text }: { text: string }) => tokenizer.encode(text, { add_special_tokens: false }).map(BigInt);
    const ordinaryMarkers = [...encode({ text: '<thi' }), ...encode({ text: 'nk>literal</thi' }), ...encode({ text: 'nk>' })];
    expect(tokenizer.decode(ordinaryMarkers, { skip_special_tokens: false })).toBe('<think>literal</think>');
    expect(ordinaryMarkers).not.toContain(BigInt(tokenizer.encode('<think>', { add_special_tokens: false })[0]!));
    const events: InferenceGenerationEvent[] = [];
    const decoder = createQwen3_5Generation({ prompt: `\
<|im_start|>assistant
<think>
`, tools: undefined,
    emit: ({ event }) => {
      events.push(event);
    },
    });
    const streamer = new NativeProtocolStreamer({ tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'],
      protocolTokens: qwen3_5ProtocolTokens,
      onText: ({ text }) => decoder.text({ text }), onControl: ({ token }) => decoder.control({ token }),
    });
    const ids = [...encode({ text: `\
  理由🙂

</think>

` }), ...ordinaryMarkers, ...encode({ text: 'Answer  <|im_end|>' })];
    streamer.put([encode({ text: `\
<|im_start|>assistant
<think>
` })]);
    switch (delivery) {
    case 'single': for (const id of ids) streamer.put([[id]]); break;
    case 'batch': streamer.put([ids]); break;
    default: { const exhaustive: never = delivery; throw new Error(`Unhandled delivery: ${exhaustive}`); }
    }
    streamer.end(); decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start')).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'part_start', index: 1, kind: 'text' },
    ]);
    expect(events.filter(e => e.type === 'text_delta' && e.index === 0).map(e => e.type === 'text_delta' ? e.text : '').join('')).toBe('  理由🙂\n');
    expect(events.filter(e => e.type === 'text_delta' && e.index === 1).map(e => e.type === 'text_delta' ? e.text : '').join('')).toBe('<think>literal</think>Answer  ');
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);

  it('rejects a non-atomic delimiter rather than scanning visible text for it', async () => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = (await harness.runtime.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined })) as unknown as Context['tokenizer'];
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const token = 'not a model delimiter';
    expect(tokenizer.encode(token, { add_special_tokens: false }).length).toBeGreaterThan(1);
    expect(() => new NativeProtocolStreamer({ tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'],
      protocolTokens: [token], onText: () => {}, onControl: () => {},
    })).toThrow('atomic');
    expect(harness.sessions).not.toHaveBeenCalled();
  }, 20_000);

  it.each(['answer', 'calls', 'partial', 'native_failure'] as const)('connects the actual strategy and local parts for %s', async shape => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    const tokenizer = processor.tokenizer as unknown as Context['tokenizer'];
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { selectGenerationStrategy } = await import('@/features/transformers-js/generation-strategies');
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const output = (() => {
      switch (shape) {
      case 'answer': return `\
R
</think>

答え🙂  <|im_end|>`;
      case 'calls': return `\
R
</think>

<tool_call>
<function=calculator>
<parameter=expression>
17 * 23
</parameter>
</function>
</tool_call><|im_end|>`;
      case 'partial': case 'native_failure': return '  未完🙂\n';
      default: { const exhaustive: never = shape; throw new Error(`Unhandled shape: ${exhaustive}`); }
      }
    })();
    const generated = tokenizer.encode(output, { add_special_tokens: false }).map(BigInt);
    const nativeEnded = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const fault = new Error('synthetic native failure'); const onChunk = vi.fn(); const onToolCalls = vi.fn();
    const nativeGenerate = vi.fn(async ({ streamer, input_ids, past_key_values }: { streamer: NativeStreamerType, input_ids: { data: Iterable<bigint> }, past_key_values: unknown }) => {
      expect(streamer).toBeInstanceOf(NativeProtocolStreamer); expect(past_key_values).toBeNull();
      expect(tokenizer.decode([...input_ids.data], { skip_special_tokens: false }).endsWith(`\
<|im_start|>assistant
<think>
`)).toBe(true);
      streamer.put([[...input_ids.data]]); streamer.put([generated]); streamer.end(); nativeEnded.resolve(); await release.promise;
      if (shape === 'native_failure') throw fault;
      return { past_key_values: null };
    });
    const state: Context['runtimeState'] = { activeModelId: modelId, gemma4Processor: null,
      qwen3_5Processor: processor as unknown as Context['runtimeState']['qwen3_5Processor'],
      gptOssPastKeyValues: null, qwen3_5SequenceCache: undefined, qwen3_5ConversationState: undefined, generationStateOwner: {},
    };
    const node = assistant(); const abortController = new AbortController();
    const { createInferenceEventDelivery } = await import('@/features/transformers-js/worker/inference-event-delivery');
    const operation = consumeChatGeneration({ node, abortController, onChange: () => {}, items: createInferenceGeneration({ signal: abortController.signal,
      generate: async ({ onEvent }) => {
        const queue = createInferenceEventDelivery({ onEvent, onFailure: () => {} });
        try {
          await selectGenerationStrategy({ modelType: 'qwen3_5', activeModelId: modelId }).generate({
            model: { config: {}, sessions: {}, generate: nativeGenerate } as unknown as Context['model'],
            tokenizer: tokenizer as unknown as Context['tokenizer'], messages: [{ role: 'user', content: 'Calculate.' }], onChunk, onToolCalls, onRawChunk: () => {},
            params: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'high' } }, tools: [{ type: 'function', function: { name: 'calculator', description: 'Arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } } } } }],
            stoppingCriteria: { reset: () => {}, interrupt: () => {} }, runtimeState: state, debugLog: () => {},
            observationSink: undefined, generationCapture: undefined, onGenerationEvent: ({ event }) => queue.enqueue({ event }),
          });
        } finally {
          await queue.finish();
        }
      },
    }) });
    let settled = false; void operation.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await nativeEnded.promise; await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    // The native stream can finish before its asynchronous model operation.
    release.resolve(); const result = await operation;
    expect(nativeGenerate).toHaveBeenCalledOnce(); expect(onChunk).not.toHaveBeenCalled(); expect(onToolCalls).not.toHaveBeenCalled();
    expect(state.qwen3_5SequenceCache).toBeUndefined();
    switch (shape) {
    case 'answer':
      expect(node.parts.map(p => p.type)).toEqual(['reasoning', 'text']);
      expect(node.parts[0]).toMatchObject({ text: 'R', completeness: 'complete' });
      expect(node.parts[1]).toMatchObject({ text: '答え🙂  ', completeness: 'complete' });
      expect(result).toEqual({ type: 'finished', next: 'user' }); break;
    case 'calls':
      expect(node.parts.map(p => p.type)).toEqual(['reasoning', 'tool_call']);
      expect(node.parts[1]).toMatchObject({ toolCall: { function: { name: 'calculator', arguments: '{"expression":"17 * 23"}' } } });
      expect(result).toEqual({ type: 'finished', next: 'tool_results' }); break;
    case 'partial':
      expect(node.parts[0]).toMatchObject({ text: '  未完🙂\n', completeness: 'partial' });
      expect(result).toEqual({ type: 'interrupted', reason: 'unknown' }); expect(state.qwen3_5ConversationState).toBeUndefined(); break;
    case 'native_failure':
      expect(node.parts[0]).toMatchObject({ text: '  未完🙂\n', completeness: 'partial' });
      expect(result).toEqual({ type: 'error', error: fault }); expect(state.qwen3_5ConversationState).toBeUndefined(); break;
    default: { const exhaustive: never = shape; throw new Error(`Unhandled shape: ${exhaustive}`); }
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]);
  }, 20_000);

  it('preserves a canonical thought and call prefix through real storage mapping and the original template', async () => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    const tokenizer = processor.tokenizer as unknown as Context['tokenizer'];
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const native = `\
R
</think>

<tool_call>
<function=calculator>
<parameter=expression>
17 * 23
</parameter>
</function>
</tool_call><|im_end|>`;
    const prefix = `\
<|im_start|>user
Calculate.<|im_end|>
<|im_start|>assistant
<think>
`;
    const node = assistant();
    const operation = consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {}, items: createInferenceGeneration({ signal: undefined,
      generate: async ({ onEvent }) => {
        const events: InferenceGenerationEvent[] = [];
        const codec = createQwen3_5Generation({ prompt: prefix,
          tools: [{ type: 'function', function: { name: 'calculator', description: '', parameters: { type: 'object', properties: { expression: { type: 'string' } } } } }],
          emit: ({ event }) => {
            events.push(event);
          },
        });
        const streamer = new NativeProtocolStreamer({ tokenizer, protocolTokens: qwen3_5ProtocolTokens,
          onText: ({ text }) => codec.text({ text }), onControl: ({ token }) => codec.control({ token }),
        });
        streamer.put([tokenizer.encode(prefix, { add_special_tokens: false }).map(BigInt)]);
        streamer.put([tokenizer.encode(native, { add_special_tokens: false }).map(BigInt)]);
        streamer.end(); codec.finish({ reason: 'unknown' });
        for (const event of events) await onEvent({ event });
      },
    }) });
    expect(await operation).toEqual({ type: 'finished', next: 'tool_results' });
    const call = node.parts.find(p => p.type === 'tool_call'); if (!call) throw new Error('Expected a native completed call.');
    const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'tool_result', result: { toolCallId: call.toolCall.id, status: 'success', content: { type: 'text', text: '391' } } }], replies: { items: [] } };
    node.replies.items.push(tool);
    const user: UserMessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'text', text: 'Calculate.', completeness: 'complete' }], replies: { items: [node] } };
    const chat: ChatContent = { root: { items: [user] }, currentLeafId: tool.id };
    const storage = new MemoryStorageProvider(); const id = toChatId({ raw: 'qwen-native' });
    await storage.saveChatContent({ id, content: chat }); const loaded = await storage.loadChatContent({ id }); if (!loaded) throw new Error('Expected saved content.');
    // The generation and its expected following prompt are independent finite
    // controls. The tool's result was supplied locally, not executed by a model.
    const expected = `\
<|im_start|>user
Calculate.<|im_end|>
<|im_start|>assistant
<think>
R
</think>

<tool_call>
<function=calculator>
<parameter=expression>
17 * 23
</parameter>
</function>
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
391
</tool_response><|im_end|>
<|im_start|>assistant
<think>
`;
    for (const history of [chat, loaded]) {
      const messages = buildChatGenerationMessages({ chat: history, excludedMessageId: undefined, systemPromptMessages: [] });
      const request = await prepareInferenceRequest({ messages, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined });
      const prompt = buildQwen3_5Prompt({ messages: request.messages, tools: undefined, reasoningMode: 'enabled', tokenizer });
      expect(prompt).toBe(expected);
      const ids = tokenizer.encode(prompt, { add_special_tokens: false });
      expect(ids).toEqual(tokenizer.encode(expected, { add_special_tokens: false }));
      const preceding = tokenizer.encode(prefix + native, { add_special_tokens: false });
      expect(ids.slice(0, preceding.length)).toEqual(preceding);
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);
});
