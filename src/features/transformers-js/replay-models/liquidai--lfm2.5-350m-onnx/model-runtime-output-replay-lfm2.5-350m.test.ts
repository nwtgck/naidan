// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFor, start, installRawReplay, jsonBody } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import { createInferenceGeneration } from '@/features/transformers-js/create-inference-generation';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { prepareInferenceRequest } from '@/features/transformers-js/message-projection';
import { formatStandardMessagesForToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatContent, UserMessageNode, ToolMessageNode } from '@/01-models/types';
import type { GenerationStrategy } from '@/features/transformers-js/generation-strategies';
import type { NativeProtocolStreamer as NativeStreamerType } from '@/features/transformers-js/models/native-protocol-streamer';
// eslint-disable-next-line no-restricted-imports -- Types for the original runtime loaded only inside this offline model fixture.
import type * as Tjs from '@huggingface/transformers';

type Context = Parameters<GenerationStrategy['generate']>[0];
const modelId = "LiquidAI/LFM2.5-350M-ONNX";
installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers'); vi.resetModules();
});
function assistant(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [], createdAt: 1, modelId, lmParameters: undefined, interruption: undefined, replies: { items: [] } };
}

// These are synthetic generated sequences using the repository-owned original
// tokenizer. They do not supply missing recorded inference or execute weights.
describe("LFM2.5 350M original tokenizer and structured standard generation", () => {
  it.each(['answer', 'partial', 'native_failure'] as const)('connects standard native %s to the local parts consumer', async shape => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const native = harness.runtime as unknown as typeof Tjs;
    const tokenizer = await native.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { selectGenerationStrategy } = await import('@/features/transformers-js/generation-strategies');
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const fragments = ['  <thi', 'nk>literal</th', 'ink>🙂\n', 'tail'];
    const generated = fragments.flatMap(text => tokenizer.encode(text, { add_special_tokens: false })).map(BigInt);
    if (shape === 'answer') generated.push(BigInt(7));
    const release = Promise.withResolvers<void>(); const nativeEnded = Promise.withResolvers<void>();
    const fault = new Error('Synthetic generation failure before streamer.end');
    const generate = vi.fn(async ({ streamer, input_ids, past_key_values }: { streamer: NativeStreamerType, input_ids: { data: Iterable<bigint> }, past_key_values: unknown }) => {
      expect(streamer).toBeInstanceOf(NativeProtocolStreamer); expect(past_key_values).toBeNull();
      streamer.put([[...input_ids.data]]); streamer.put([generated]);
      if (shape !== 'native_failure') streamer.end();
      nativeEnded.resolve(); await release.promise;
      if (shape === 'native_failure') throw fault;
      return { past_key_values: null };
    });
    const model = { config: jsonBody({ archive, path: 'config.json' }), configs: { generation_config: jsonBody({ archive, path: 'generation_config.json' }) },
      _prepare_generation_config: native.PreTrainedModel.prototype._prepare_generation_config, generate,
    } as unknown as Context['model'];
    const onChunk = vi.fn(); const onToolCalls = vi.fn(); const controller = new AbortController(); const node = assistant();
    const input = await prepareInferenceRequest({ messages: [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'u1', type: 'text', text: 'Hel', completeness: 'complete' }, { id: 'u2', type: 'text', text: 'lo', completeness: 'complete' }] }], parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined });
    const { createInferenceEventDelivery } = await import('@/features/transformers-js/worker/inference-event-delivery');
    const operation = consumeChatGeneration({ node, abortController: controller, onChange: () => {}, items: createInferenceGeneration({ signal: controller.signal,
      generate: async ({ onEvent }) => {
        const queue = createInferenceEventDelivery({ onEvent, onFailure: () => {} });
        try {
          const strategy = selectGenerationStrategy({ modelType: "lfm2", activeModelId: modelId }); expect(strategy.kind).toBe('standard');
          await strategy.generate({ model, tokenizer, messages: input.messages, params: undefined, tools: undefined,
            onChunk, onToolCalls, onRawChunk: () => {}, debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
            runtimeState: { activeModelId: modelId, gemma4Processor: null, qwen3_5Processor: null, gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, qwen3_5SequenceCache: undefined, generationStateOwner: {} },
            stoppingCriteria: { reset: () => {}, interrupt: () => {} }, onGenerationEvent: ({ event }) => queue.enqueue({ event }),
          });
        } finally {
          await queue.finish();
        }
      },
    }) });
    let settled = false; void operation.then(() => {
      settled = true;
    });
    await nativeEnded.promise; await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    release.resolve(); const result = await operation;
    expect(node.parts).toEqual([expect.objectContaining({ type: 'text', text: fragments.join(''), completeness: shape === 'answer' ? 'complete' : 'partial' })]);
    expect(result).toEqual(shape === 'answer' ? { type: 'finished', next: 'user' } : shape === 'partial' ? { type: 'interrupted', reason: 'unknown' } : { type: 'error', error: fault });
    expect(onChunk).not.toHaveBeenCalled(); expect(onToolCalls).not.toHaveBeenCalled(); expect(generate).toHaveBeenCalledOnce();
    const supplied = generate.mock.calls[0]![0];
    expect([...supplied.input_ids.data]).toEqual(tokenizer.encode(`\
<|startoftext|><|im_start|>user
Hello<|im_end|>
<|im_start|>assistant
`, { add_special_tokens: false }).map(BigInt));
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]);
  }, 20_000);

  it('preserves the stored text parts when the original template builds the next input', async () => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const native = harness.runtime as unknown as typeof Tjs;
    const tokenizer = await native.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true });
    const node = assistant(); node.parts = [{ id: 'p1', type: 'text', text: '  <think>literal</think>🙂\r\n', completeness: 'complete' }, { id: 'p2', type: 'text', text: 'tail ', completeness: 'complete' }];
    const next: UserMessageNode = { id: toMessageId({ raw: 'u2' }), role: 'user', parts: [{ id: 'q', type: 'text', text: 'Next', completeness: 'complete' }], createdAt: 3, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    node.replies.items.push(next);
    const user: UserMessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'p', type: 'text', text: 'Hello', completeness: 'complete' }], createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [node] } };
    const content: ChatContent = { root: { items: [user] }, currentLeafId: next.id };
    const storage = new MemoryStorageProvider(); const chatId = toChatId({ raw: 'native-standard' });
    await storage.saveChatContent({ id: chatId, content }); const loaded = await storage.loadChatContent({ id: chatId }); expect(loaded).not.toBeNull();
    expect(await storage.loadChatContent({ id: toChatId({ raw: 'different-unsaved-chat' }) })).toBeNull();
    const expected = `\
<|startoftext|><|im_start|>user
Hello<|im_end|>
<|im_start|>assistant
  <think>literal</think>🙂${'\r\n'}tail <|im_end|>
<|im_start|>user
Next<|im_end|>
<|im_start|>assistant
`;
    for (const chat of [content, loaded!]) {
      const messages = buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] });
      const request = await prepareInferenceRequest({ messages, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined });
      const templateMessages = formatStandardMessagesForToolHandling({ messages: request.messages, handling: { outputProtocol: 'json-tagged', historyEncoding: 'native-template', preservedDelimiterIds: [] } });
      const actual = tokenizer.apply_chat_template(templateMessages, { tokenize: false, add_generation_prompt: true });
      expect(actual).toBe(expected);
      expect(tokenizer.encode(actual as string, { add_special_tokens: false })).toEqual(tokenizer.encode(expected, { add_special_tokens: false }));
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]);
  }, 20_000);
  it('records an admitted native tool frame and reuses the same original history route after storage', async () => {
    const archive = await archiveFor({ modelId }); const { harness } = await start({ archive, bodyPaths: [] });
    const native = harness.runtime as unknown as typeof Tjs;
    const tokenizer = await native.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { selectGenerationStrategy } = await import('@/features/transformers-js/generation-strategies');
    const { resolveStandardToolHandling } = await import('@/features/transformers-js/standard-tool-call-protocol');
    const { createInferenceEventDelivery } = await import('@/features/transformers-js/worker/inference-event-delivery');
    const handling = resolveStandardToolHandling({ tokenizer, debugLog: () => {} });
    expect(handling.historyEncoding).toBe('verified-content'); expect(handling.outputProtocol).toBe('delimited-pythonic');
    const ids = tokenizer.encode('<|tool_call_start|>[f(x=" a ")]<|tool_call_end|><|im_end|>', { add_special_tokens: false }).map(BigInt);
    const receivedInputs: bigint[][] = [];
    const generate = vi.fn(async ({ streamer, input_ids }: { streamer: NativeStreamerType, input_ids: { data: Iterable<bigint> } }) => {
      receivedInputs.push([...input_ids.data]);
      streamer.put([[...input_ids.data]]);
      streamer.put([receivedInputs.length === 1 ? ids : tokenizer.encode('Result<|im_end|>', { add_special_tokens: false }).map(BigInt)]);
      streamer.end(); return { past_key_values: null };
    });
    const model = { config: jsonBody({ archive, path: 'config.json' }), configs: { generation_config: jsonBody({ archive, path: 'generation_config.json' }) },
      _prepare_generation_config: native.PreTrainedModel.prototype._prepare_generation_config, generate,
    } as unknown as Context['model'];
    const node = assistant(); const user: UserMessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'p', type: 'text', text: 'Hello', completeness: 'complete' }], createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [node] } };
    const controller = new AbortController();
    async function run({ request, node }: { request: Awaited<ReturnType<typeof prepareInferenceRequest>>, node: AssistantMessageNode }) {
      return consumeChatGeneration({ node, abortController: controller, onChange: () => {}, items: createInferenceGeneration({ signal: controller.signal,
        generate: async ({ onEvent }) => {
          const queue = createInferenceEventDelivery({ onEvent, onFailure: () => {} });
          try {
            await selectGenerationStrategy({ modelType: 'lfm2', activeModelId: modelId }).generate({
              model, tokenizer, messages: request.messages, tools: request.tools, params: undefined,
              onChunk: () => {
                throw new Error('Legacy output must not be used');
              }, onToolCalls: () => {
                throw new Error('Legacy calls must not be used');
              }, onRawChunk: () => {}, debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
              runtimeState: { activeModelId: modelId, gemma4Processor: null, qwen3_5Processor: null, gptOssPastKeyValues: null, qwen3_5ConversationState: undefined, qwen3_5SequenceCache: undefined, generationStateOwner: {} },
              stoppingCriteria: { reset: () => {}, interrupt: () => {} }, onGenerationEvent: ({ event }) => queue.enqueue({ event }),
            });
          } finally {
            await queue.finish();
          }
        },
      }) });
    }
    const request = await prepareInferenceRequest({ messages: [{ id: user.id, role: 'user', parts: user.parts }], parameters: undefined, tools: [{ name: 'f', description: '', parameters: { type: 'object' } }], readBinaryObject: undefined, signal: undefined });
    expect(await run({ request, node })).toEqual({ type: 'finished', next: 'tool_results' });
    expect(node.parts).toHaveLength(1); const part = node.parts[0]!;
    if (part.type !== 'tool_call') throw new Error('Expected a complete call');
    expect(part.toolCall.function).toEqual({ name: 'f', arguments: '{"x":" a "}' });
    const result: ToolMessageNode = { id: toMessageId({ raw: 'result' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'result-1', type: 'tool_result', result: { toolCallId: part.toolCall.id, status: 'success', content: { type: 'text', text: 'tool reply' } } }], replies: { items: [] } };
    node.replies.items.push(result);
    const content: ChatContent = { root: { items: [user] }, currentLeafId: result.id };
    const storage = new MemoryStorageProvider(); const chatId = toChatId({ raw: 'standard-tool-roundtrip' });
    await storage.saveChatContent({ id: chatId, content }); const loaded = await storage.loadChatContent({ id: chatId }); expect(loaded).not.toBeNull();
    expect(await storage.loadChatContent({ id: toChatId({ raw: 'different-unsaved-chat' }) })).toBeNull();
    const expected = `\
<|startoftext|><|im_start|>user
Hello<|im_end|>
<|im_start|>assistant
<|tool_call_start|>[f(x=" a ")]<|tool_call_end|><|im_end|>
<|im_start|>tool
tool reply<|im_end|>
<|im_start|>assistant
`;
    for (const chat of [content, loaded!]) {
      // Historical calls still need their observed encoding, even when this
      // request intentionally advertises no additional tools.
      const request = await prepareInferenceRequest({ messages: buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] }), parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined });
      const next = assistant();
      expect(await run({ request, node: next })).toEqual({ type: 'finished', next: 'user' });
      expect(receivedInputs.at(-1)).toEqual(tokenizer.encode(expected, { add_special_tokens: false }).map(BigInt));
      expect(next.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Result', completeness: 'complete' })]);
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.transport).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]);
  }, 20_000);

});
