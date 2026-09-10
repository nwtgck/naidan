// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- Types describe the instrumented native generation boundary in this Worker regression.
import type { PreTrainedModel, PreTrainedTokenizer, TextStreamer } from '@huggingface/transformers';
import { archiveFor, installRawReplay, start } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';

installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
});

describe('GPT-OSS Production generation replay', () => {
  it('interprets the recorded no-tools analysis output through the Production strategy', async () => {
    const modelId = 'onnx-community/gpt-oss-20b-ONNX';
    const archive = await archiveFor({ modelId });
    expect(archive.summary.revision).toBe('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7');
    const { harness } = await start({ archive, bodyPaths: [] });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { selectGenerationStrategy } = await import('@/features/transformers-js/generation-strategies');
    const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    }) as unknown as PreTrainedTokenizer;
    // Only generated token IDs from MSI's fixed synthetic prompt are replayed.
    // No user conversation, weights, GPU result, or private ZIP is needed in CI.
    const generatedIds = [200005, 35644, 200008, 976, 1825, 5003, 392, 8396, 31925, 1825, 3176, 3692, 1328, 7890, 1299, 261];
    expect(tokenizer.decode(generatedIds, { skip_special_tokens: false }))
      .toBe('<|channel|>analysis<|message|>The user says "Template probe user message." This seems like a');
    const generate = vi.fn(async (inputs: Record<string, unknown>) => {
      const streamer = inputs['streamer'] as TextStreamer;
      const prompt = inputs['input_ids'] as { data: BigInt64Array };
      streamer.put([Array.from(prompt.data)]);
      for (const id of generatedIds) streamer.put([[BigInt(id)]]);
      streamer.end();
      return { past_key_values: undefined, sequences: { data: BigInt64Array.from([...prompt.data, ...generatedIds.map(BigInt)]) } };
    });
    const chunks: string[] = [];
    const strategy = selectGenerationStrategy({ modelType: 'gpt_oss', activeModelId: modelId });
    await strategy.generate({
      // Only native model execution is instrumented; tokenizer, streamer,
      // strategy selection and output interpretation are the actual code.
      model: { config: { model_type: 'gpt_oss' }, generate } as unknown as PreTrainedModel,
      tokenizer,
      messages: [{ role: 'user', content: 'Template probe user message.' }],
      onChunk: ({ chunk }) => chunks.push(chunk), onRawChunk: () => {}, onToolCalls: () => {},
      params: undefined, tools: undefined,
      runtimeState: {
        activeModelId: modelId, gemma4Processor: null, qwen3_5Processor: null,
        gptOssPastKeyValues: undefined, qwen3_5ConversationState: undefined,
        generationStateOwner: {}, qwen3_5SequenceCache: undefined,
      },
      stoppingCriteria: { reset: () => {}, interrupt: () => {} },
      debugLog: () => {}, observationSink: undefined, generationCapture: undefined,
    });
    expect(chunks.join('')).toBe('<think>The user says "Template probe user message." This seems like a');
    expect(generate).toHaveBeenCalledOnce();
    expect(harness.sessions).not.toHaveBeenCalled();
    expect(harness.transport).not.toHaveBeenCalled();
  });
});
