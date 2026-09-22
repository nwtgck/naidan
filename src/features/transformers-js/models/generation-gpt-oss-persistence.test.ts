// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { roundTripChatContentPersistenceSerialization } from '@/00-storage/service/chat-content-serialization';
import { toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatContent, LmParameters, MessageNode, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/provider-evidence-catalog';
import ownedRepresentative from '@/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/provider-natural-tool-representative-owned-cache.evidence.json';
import ownedProvenance from '@/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/provider-owned-tools-provenance.evidence.json';
import ownedSequence from '@/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/provider-owned-tools-sequence.evidence.json';
import type { ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplayWithOwnedCacheControl } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import type { OwnedReplayCacheControl } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';

const modelId = 'onnx-community/gpt-oss-20b-ONNX';
const caseId = 'natural-tool-representative';
const parameters: LmParameters = {
  temperature: 0, topP: 1, maxCompletionTokens: 128,
  presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined,
  reasoning: { effort: undefined },
};
const catalog = {
  context: providerReplayCatalog.context,
  provenance: ownedProvenance,
  sequence: ownedSequence,
  cases: { [caseId]: ownedRepresentative },
} satisfies ProviderReplayCatalog;
const artifactPaths = [
  'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
  ...Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index + 1}`),
];

async function runTurn({ persistence }: { persistence: 'live' | 'json-roundtrip' }) {
  let cache: OwnedReplayCacheControl | undefined;
  const nativeInputs: { ids: bigint[], attentionMask: bigint[], reusedCache: boolean }[] = [];
  const replay = await createProviderRequestReplayWithOwnedCacheControl({
    catalog, caseIds: [caseId], artifactPaths, imagePlatform: undefined,
    createNativeController: () => ({
      cacheForInvocation({ localOrdinal, call }) {
        const { input_ids, attention_mask, past_key_values } = call.options;
        if (!(input_ids instanceof call.runtime.Tensor) || !(attention_mask instanceof call.runtime.Tensor)) {
          throw new Error('Expected actual native input tensors');
        }
        nativeInputs.push({
          ids: Array.from(input_ids.data, BigInt),
          attentionMask: Array.from(attention_mask.data, BigInt),
          reusedCache: past_key_values !== null,
        });
        if (localOrdinal === 1) {
          expect(past_key_values).toBeNull();
          return undefined;
        }
        expect(localOrdinal).toBe(2);
        if (cache === undefined) throw new Error('Missing the first invocation cache');
        expect(past_key_values).toBe(cache.pastKeyValues);
        const prefix = Array.from(cache.previousSequence.data, BigInt);
        expect(nativeInputs[1]!.ids.slice(0, prefix.length)).toEqual(prefix);
        expect(nativeInputs[1]!.ids.length).toBeGreaterThan(prefix.length);
        // The replay gate also compares actual native tensors and settings to
        // the immutable capture before releasing its recorded output tokens.
        return cache;
      },
      completeResult({ localOrdinal, result, runtime }) {
        if (localOrdinal !== 1) return result;
        // Only cache identity and observed length are synthetic. The sequence
        // and the tokenizer/template inputs are real pinned runtime tensors;
        // neither GPU KV bytes nor model inference performance are tested here.
        const pastKeyValues = new runtime.DynamicCache();
        vi.spyOn(pastKeyValues, 'get_seq_length').mockReturnValue(result.sequences.dims[1]! - 1);
        cache = { previousSequence: result.sequences, pastKeyValues };
        return { ...result, past_key_values: pastKeyValues };
      },
    }),
  });
  const user: UserMessageNode = {
    id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1,
    modelId: undefined, lmParameters: undefined,
    parts: [{ type: 'text', completeness: 'complete',
      text: 'Use lookup_weather for Tokyo, then give a short answer based on the tool result.' }],
    replies: { items: [] },
  };
  const content: ChatContent = { currentLeafId: user.id, root: { items: [user] } };
  const history: MessageNode[] = [user];
  const snapshots: ChatContent[] = [];
  function append({ node }: { node: MessageNode }): void {
    history.at(-1)!.replies.items.push(node);
    history.push(node);
    content.currentLeafId = node.id;
  }
  const execute = vi.fn<Tool['execute']>(async () => ({
    status: 'success', content: '{"temperatureC":20,"condition":"clear"}',
  }));
  const tool: Tool = {
    name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
    parametersSchema: z.object({ city: z.string() }), execute,
  };
  try {
    replay.beginNativeRequest({ caseId, parameters });
    const outcome = await generateChatTurn({
      provider: replay.provider, model: modelId, parameters, tools: [tool],
      readBinaryObject: undefined, debug: undefined, abortController: new AbortController(), approvalContext: undefined,
      createAssistantMessage: () => {
        const node: AssistantMessageNode = {
          id: toMessageId({ raw: `message_${history.length}` }), role: 'assistant', createdAt: history.length,
          modelId, lmParameters: parameters, interruption: undefined, parts: [], replies: { items: [] },
        };
        append({ node });
        return node;
      },
      createToolMessage: () => {
        const node: ToolMessageNode = {
          id: toMessageId({ raw: `message_${history.length}` }), role: 'tool', createdAt: history.length,
          modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] },
        };
        append({ node });
        return node;
      },
      buildMessages: ({ excludedMessageId }) => {
        const before = structuredClone(content);
        const restored = persistence === 'json-roundtrip'
          ? roundTripChatContentPersistenceSerialization({ content }).restored
          : content;
        expect(restored).toEqual(before);
        expect(content).toEqual(before);
        snapshots.push(structuredClone(restored));
        return buildChatGenerationMessages({ chat: restored, excludedMessageId, systemPromptMessages: [] });
      },
      onChange: () => {}, onToolEvent: () => {},
      persistToolContent: async ({ text }) => ({ type: 'text', text }),
      describeError: ({ error }) => error.message,
    });
    expect(outcome).toEqual({ type: 'finished', next: 'user' });
    replay.endNativeRequest();
    replay.assertComplete({ requests: 1, nativeCalls: 2 });
    expect(nativeInputs.map(input => input.reusedCache)).toEqual([false, true]);
    expect(snapshots).toHaveLength(2);
    const continuation = buildChatGenerationMessages({
      chat: snapshots[1]!, excludedMessageId: history[3]!.id, systemPromptMessages: [],
    });
    expect(continuation.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = continuation[1];
    const call = assistant?.parts.at(-1);
    if (assistant?.role !== 'assistant' || call?.type !== 'tool_call') throw new Error('Missing captured tool call');
    expect(assistant.parts).toEqual([
      { type: 'reasoning', text: 'We need to call the function lookup_weather with city "Tokyo".', completeness: 'complete' },
      { type: 'tool_call', toolCall: {
        id: call.toolCall.id, type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
      } },
    ]);
    expect(continuation[2]?.parts).toEqual([{ type: 'tool_result', result: {
      toolCallId: call.toolCall.id, status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' },
    } }]);
    expect(history[3]?.parts).toEqual([{ type: 'text',
      text: 'Tokyo is clear with a comfortable temperature of about 20\u202f°C.', completeness: 'complete' }]);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ args: { city: 'Tokyo' }, signal: expect.any(AbortSignal), approvalContext: undefined, onEvent: expect.any(Function) });
    return nativeInputs;
  } finally {
    await replay.close();
  }
}

describe('GPT-OSS persisted parts at the owned native continuation boundary', () => {
  it('keeps recorded template/tokenizer inputs and compatible cache after JSON save and reload', async () => {
    // The pinned template includes a clock date. Both paths use the recording's
    // date; the persistence helper exercises JSON/DTO mapping, not OPFS I/O.
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    try {
      const live = await runTurn({ persistence: 'live' });
      const restored = await runTurn({ persistence: 'json-roundtrip' });
      expect(restored).toEqual(live);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
