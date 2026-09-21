// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFor, start, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import { createGemma4Generation } from '@/features/transformers-js/models/gemma4-generation';
import { createInferenceGeneration } from '@/features/transformers-js/create-inference-generation';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { buildGemma4TemplateInput, type Gemma4ProcessorLike } from '@/features/transformers-js/models/gemma4';
import { prepareInferenceRequest } from '@/features/transformers-js/message-projection';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatContent, UserMessageNode, ToolMessageNode } from '@/01-models/types';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { GenerationStrategy } from '@/features/transformers-js/generation-strategies';
import type { NativeProtocolStreamer as NativeStreamerType } from '@/features/transformers-js/models/native-protocol-streamer';

type GenerationStrategyContext = Parameters<GenerationStrategy['generate']>[0];

const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers'); vi.resetModules();
});

function assistant(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a1' }), role: 'assistant', parts: [], createdAt: 1,
    modelId, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

describe('Gemma native output with the Production streamer and original tokenizer', () => {
  it.each(['single', 'batch'] as const)('uses native IDs rather than decoded marker spellings with %s delivery', async delivery => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const events: InferenceGenerationEvent[] = [];
    const decoder = createGemma4Generation({ toolCalls: 'disabled', emit: ({ event }) => {
      events.push(event);
    } });
    const streamer = new NativeProtocolStreamer({ protocolTokens: undefined, tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'],
      onText: ({ text }) => decoder.text({ text }), onControl: ({ token }) => decoder.control({ token }),
    });
    // Source-derived finite native output, not a newly recorded model run.
    const ids = tokenizer.encode(`<|channel>thought\n  確認🙂\n\n<channel|><think>literal</think>Answer  <turn|>`, { add_special_tokens: false }).map(BigInt);
    streamer.put([tokenizer.encode('<|turn>model\n', { add_special_tokens: false }).map(BigInt)]);
    switch (delivery) {
    case 'single': for (const id of ids) streamer.put([[id]]); break;
    case 'batch': streamer.put([ids]); break;
    default: { const exhaustive: never = delivery; throw new Error(`Unhandled delivery: ${exhaustive}`); }
    }
    streamer.end(); decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start')).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'part_start', index: 1, kind: 'text' },
    ]);
    expect(events.filter(e => e.type === 'text_delta').filter(e => e.index === 0).map(e => e.text).join('')).toBe('  確認🙂\n');
    expect(events.filter(e => e.type === 'text_delta').filter(e => e.index === 1).map(e => e.text).join('')).toBe('<think>literal</think>Answer  ');
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);

  it.each(['answer', 'calls', 'partial', 'native_failure'] as const)('connects the real generation strategy to local parts for %s', async shape => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    const tokenizer = processor.tokenizer;
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { selectGenerationStrategy } = await import('@/features/transformers-js/generation-strategies');
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const output = (() => {
      switch (shape) {
      case 'answer': return `\
<|channel>thought
  R
<channel|><think>literal</think>Answer  <turn|>`;
      case 'calls': return `\
<|channel>thought
  R
<channel|><|tool_call>call:calculator{expression:<|"|>17 * 23<|"|>}<tool_call|><|tool_call>call:calculator{expression:<|"|>2 + 2<|"|>}<tool_call|><|tool_response>`;
      case 'partial': case 'native_failure': return `\
<|channel>thought
  未完🙂
`;
      default: { const exhaustive: never = shape; throw new Error(`Unhandled shape: ${exhaustive}`); }
      }
    })();
    const generated = tokenizer.encode(output, { add_special_tokens: false }).map(BigInt);
    const nativeEnded = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const onChunk = vi.fn(); const onToolCalls = vi.fn(); const fault = new Error('synthetic native failure');
    const nativeGenerate = vi.fn(async ({ streamer, input_ids, past_key_values }: { streamer: NativeStreamerType, input_ids: { data: Iterable<bigint> }, past_key_values: unknown }) => {
      expect(streamer).toBeInstanceOf(NativeProtocolStreamer); expect(past_key_values).toBeNull();
      streamer.put([[...input_ids.data]]); streamer.put([generated]); streamer.end();
      nativeEnded.resolve(); await release.promise;
      if (shape === 'native_failure') throw fault;
      return { past_key_values: null };
    });
    const state: GenerationStrategyContext['runtimeState'] = {
      activeModelId: modelId, gemma4Processor: processor as unknown as GenerationStrategyContext['runtimeState']['gemma4Processor'],
      qwen3_5Processor: null, gptOssPastKeyValues: null, qwen3_5SequenceCache: undefined, qwen3_5ConversationState: undefined, generationStateOwner: {},
    };
    const events: InferenceGenerationEvent[] = [];
    const node = assistant(); const abortController = new AbortController();
    const delivery = await import('@/features/transformers-js/worker/inference-event-delivery');
    const operation = consumeChatGeneration({ node, abortController, onChange: () => {}, items: createInferenceGeneration({ signal: abortController.signal,
      generate: async ({ onEvent }) => {
        const queue = delivery.createInferenceEventDelivery({ onEvent: async ({ event }) => {
          events.push(event); await onEvent({ event });
        }, onFailure: () => {} });
        try {
          await selectGenerationStrategy({ modelType: 'gemma4', activeModelId: modelId }).generate({
            model: { config: {}, generate: nativeGenerate } as unknown as GenerationStrategyContext['model'],
            tokenizer: tokenizer as unknown as GenerationStrategyContext['tokenizer'],
            messages: [{ role: 'user', content: 'Run the source-derived example.' }], onChunk, onToolCalls, onRawChunk: () => {},
            params: undefined, tools: [{ type: 'function', function: { name: 'calculator', description: 'Arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } } } } }],
            stoppingCriteria: { reset: () => {}, interrupt: () => {} }, runtimeState: state, debugLog: () => {},
            observationSink: undefined, generationCapture: undefined, onGenerationEvent: ({ event }) => queue.enqueue({ event }),
          });
        } finally {
          await queue.finish();
        }
      },
    }) });
    let settled = false; void operation.finally(() => {
      settled = true;
    });
    await nativeEnded.promise; await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false); expect(node.parts.filter(p => p.type === 'text' || p.type === 'reasoning').length).toBeGreaterThan(0);
    release.resolve(); const result = await operation;
    expect(nativeGenerate).toHaveBeenCalledOnce(); expect(onChunk).not.toHaveBeenCalled(); expect(onToolCalls).not.toHaveBeenCalled();
    switch (shape) {
    case 'answer':
      expect(node.parts.map(p => p.type)).toEqual(['reasoning', 'text']);
      expect(node.parts[0]).toMatchObject({ text: '  R', completeness: 'complete' });
      expect(node.parts[1]).toMatchObject({ text: '<think>literal</think>Answer  ', completeness: 'complete' });
      expect(result).toEqual({ type: 'finished', next: 'user' }); break;
    case 'calls':
      expect(node.parts.map(p => p.type)).toEqual(['reasoning', 'tool_call', 'tool_call']);
      expect(node.parts[1]).toMatchObject({ toolCall: { function: { name: 'calculator', arguments: '{"expression":"17 * 23"}' } } });
      expect(result).toEqual({ type: 'finished', next: 'tool_results' }); break;
    case 'partial':
      expect(node.parts[0]).toMatchObject({ text: '  未完🙂\n', completeness: 'partial' });
      expect(result).toEqual({ type: 'interrupted', reason: 'unknown' }); break;
    case 'native_failure':
      expect(node.parts[0]).toMatchObject({ text: '  未完🙂\n', completeness: 'partial' });
      expect(result).toEqual({ type: 'error', error: fault }); break;
    default: { const exhaustive: never = shape; throw new Error(`Unhandled shape: ${exhaustive}`); }
    }
    expect(state.gptOssPastKeyValues).toBeNull(); expect(state.qwen3_5SequenceCache).toBeUndefined();
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]);
  }, 20_000);

  it('round-trips a canonical thought and tool prefix through real storage and the original template', async () => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    const tokenizer = processor.tokenizer;
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const native = `<|channel>thought\n  R\n\n<channel|><|tool_call>call:calculator{expression:<|"|>17 * 23<|"|>}<tool_call|><|tool_response>`;
    const node = assistant();
    const operation = consumeChatGeneration({ node, abortController: new AbortController(), onChange: () => {}, items: createInferenceGeneration({ signal: undefined, generate: async ({ onEvent }) => {
      const events: InferenceGenerationEvent[] = [];
      const decoder = createGemma4Generation({ toolCalls: 'enabled', emit: ({ event }) => {
        events.push(event);
      } });
      const streamer = new NativeProtocolStreamer({ protocolTokens: undefined, tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'], onText: ({ text }) => decoder.text({ text }), onControl: ({ token }) => decoder.control({ token }) });
      streamer.put([[1n]]); streamer.put([tokenizer.encode(native, { add_special_tokens: false }).map(BigInt)]); streamer.end(); decoder.finish({ reason: 'unknown' });
      for (const event of events) await onEvent({ event });
    } }) });
    expect(await operation).toEqual({ type: 'finished', next: 'tool_results' });
    const callPart = node.parts.find(p => p.type === 'tool_call'); if (!callPart) throw new Error('Expected a completed call.');
    const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'result', type: 'tool_result', result: { toolCallId: callPart.toolCall.id, status: 'success', content: { type: 'text', text: '391' } } }], replies: { items: [] } };
    node.replies.items.push(tool);
    const user: UserMessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'question', type: 'text', text: 'Calculate.', completeness: 'complete' }], replies: { items: [node] } };
    const chat: ChatContent = { root: { items: [user] }, currentLeafId: tool.id };
    const chatId = toChatId({ raw: 'gemma-native' }); const storage = new MemoryStorageProvider();
    await storage.saveChatContent({ id: chatId, content: chat }); const restored = await storage.loadChatContent({ id: chatId }); if (!restored) throw new Error('Expected stored content.');
    const expected = `<bos><|turn>user\nCalculate.<turn|>\n<|turn>model\n<|channel>thought\n  R\n\n<channel|><|tool_call>call:calculator{expression:<|"|>17 * 23<|"|>}<tool_call|><|tool_response>response:calculator{value:<|"|>391<|"|>}<tool_response|>`;
    const prompts: string[] = [];
    for (const content of [chat, restored]) {
      const messages = buildChatGenerationMessages({ chat: content, excludedMessageId: undefined, systemPromptMessages: [] });
      const request = await prepareInferenceRequest({ messages, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined });
      const { templateMessages } = await buildGemma4TemplateInput({ messages: request.messages });
      const templateProcessor = processor as unknown as Gemma4ProcessorLike;
      const prompt = templateProcessor.apply_chat_template(templateMessages, { add_generation_prompt: true, tokenize: false });
      expect(prompt).toBe(expected); prompts.push(prompt);
      // The original template's content truthiness check is observable in the
      // pinned runtime. Merely forwarding [] after a call adds an extra turn
      // terminator; the model-specific adapter must use its empty-body form.
      const unadapted = templateMessages.map(message => message.role === 'assistant' ? { ...message, content: [] } : message);
      expect(templateProcessor.apply_chat_template(unadapted, { add_generation_prompt: true, tokenize: false })).toBe(`${expected}<turn|>\n`);
      const ids = tokenizer.encode(prompt, { add_special_tokens: false }); const expectedIds = tokenizer.encode(expected, { add_special_tokens: false });
      expect(ids).toEqual(expectedIds);
      const generatedPrefix = tokenizer.encode(`<bos><|turn>user\nCalculate.<turn|>\n<|turn>model\n${native}`, { add_special_tokens: false });
      expect(ids.slice(0, generatedPrefix.length)).toEqual(generatedPrefix);
    }
    expect(prompts[0]).toBe(prompts[1]);
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);
});
