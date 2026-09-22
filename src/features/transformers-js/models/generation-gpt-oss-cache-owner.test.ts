// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { Tool } from '@/01-models/tool';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { runProviderReplayTurn } from '@/features/transformers-js/replay-models/support/provider-replay-chat';

const modelId = 'onnx-community/gpt-oss-20b-ONNX';
const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
const tool: Tool = {
  name: 'lookup_weather', description: 'Read the synthetic weather fixture.',
  parametersSchema: z.object({ city: z.string() }),
  execute: async () => ({ status: 'success', content: '{"city":"Tokyo","condition":"sunny"}' }),
};

describe('GPT-OSS public conversation cache ownership', () => {
  it.each([false, true])('isolates public chats and preserves valid tool continuation (optimization rendering failure: %s)', async failCacheRendering => {
    const seenPast: unknown[] = [];
    let firstCache: object | undefined;
    let firstSequence: bigint[] | undefined;
    let secondInput: bigint[] | undefined;
    let templateSpy: ReturnType<typeof vi.spyOn> | undefined;
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: 'all-fixture', imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', ...Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index + 1}`)]
        .map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual GPT-OSS native input');
        seenPast.push(options.past_key_values);
        expect(options).not.toHaveProperty('continuationOwner');
        if (seenPast.length === 2) secondInput = [...options.input_ids.data as BigInt64Array];
        const text = seenPast.length === 1
          ? '<|start|>assistant to=functions.lookup_weather<|channel|>commentary<|message|>{"city":"Tokyo"}<|call|>'
          : '<|start|>assistant<|channel|>final<|message|>Sunny.<|return|>';
        // Synthetic native outputs test cache ownership, not observed logits/KV.
        const generated = tokenizer.encode(text, { add_special_tokens: false });
        options.streamer.put(options.input_ids.tolist());
        for (const id of generated) options.streamer.put([[BigInt(id)]]);
        options.streamer.end();
        const sequence = BigInt64Array.from([...options.input_ids.data as BigInt64Array, ...generated.map(BigInt)]);
        const cache = { get_seq_length: () => sequence.length - 1 };
        if (seenPast.length === 1) {
          firstCache = cache;
          firstSequence = [...sequence];
          if (failCacheRendering) {
            const original = tokenizer.apply_chat_template.bind(tokenizer);
            let renderCount = 0;
            templateSpy = vi.spyOn(tokenizer, 'apply_chat_template').mockImplementation((...args) => {
              renderCount += 1;
              if (renderCount === 2) throw new Error('Only optimization base rendering failed');
              return original(...args);
            });
          }
        }
        return { sequences: new runtime.Tensor('int64', sequence, [1, sequence.length]), past_key_values: cache };
      },
    });
    const request = {
      model: modelId, debug: undefined, readBinaryObject: undefined,
      parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    };
    try {
      const first = await runProviderReplayTurn({
        provider: harness.provider,
        tools: [tool],
        abortController: new AbortController(),
        onChange: undefined,
        request: {
          ...request, messages: [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [
            { type: 'text', text: 'Use lookup_weather for Tokyo, then give a short answer based on the tool result.', completeness: 'complete' },
          ] }],
        },
      });
      expect(first.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(first.generated.map(node => node.role)).toEqual(['assistant', 'tool', 'assistant']);
      expect(seenPast).toHaveLength(2);
      expect(seenPast[0]).toBeNull();
      expect(seenPast[1]).toBe(failCacheRendering ? null : firstCache);
      if (!failCacheRendering) {
        expect(secondInput?.slice(0, firstSequence!.length)).toEqual(firstSequence);
        expect(secondInput!.length).toBeGreaterThan(firstSequence!.length);
      }
      const id = toToolCallId({ raw: 'synthetic-separate-history' });
      const separate = await runProviderReplayTurn({
        provider: harness.provider,
        tools: [tool],
        abortController: new AbortController(),
        onChange: undefined,
        request: {
          ...request, messages: [
            { id: toMessageId({ raw: 'separate-user' }), role: 'user', parts: [{ type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' }] },
            { id: toMessageId({ raw: 'separate-assistant' }), role: 'assistant', parts: [
              { type: 'text', text: '', completeness: 'complete' },
              { type: 'tool_call', toolCall: { id, type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } } },
            ] },
            { id: toMessageId({ raw: 'separate-tool' }), role: 'tool', parts: [{ type: 'tool_result', result: {
              toolCallId: id, status: 'success', content: { type: 'text', text: '{"city":"Tokyo","condition":"sunny"}' },
            } }] },
          ],
        },
      });
      expect(separate.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(seenPast).toHaveLength(3);
      expect(seenPast[2], 'Another public chat must not inherit the previous conversation cache').toBeNull();
      const repeated = await runProviderReplayTurn({
        provider: harness.provider,
        tools: [tool],
        abortController: new AbortController(),
        onChange: undefined,
        request: {
          ...request, messages: [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [
            { type: 'text', text: 'Use lookup_weather for Tokyo, then give a short answer based on the tool result.', completeness: 'complete' },
          ] }],
        },
      });
      expect(repeated.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(seenPast).toHaveLength(4);
      expect(seenPast[3], 'Even identical public request text starts a new operation').toBeNull();
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      templateSpy?.mockRestore(); await harness.close();
    }
  }, 30_000);
});
