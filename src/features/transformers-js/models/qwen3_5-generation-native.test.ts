// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFor, installRawReplay, start } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import { createQwen3_5Generation, qwen3_5ProtocolTokens } from './qwen3_5-generation';

installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
  vi.resetModules();
});

describe('Qwen native tool termination framing', () => {
  it.each(['single', 'batch'] as const)('accepts the recorded terminal token sequence with %s token delivery', async delivery => {
    const modelId = 'onnx-community/Qwen3.5-4B-ONNX';
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('./native-protocol-streamer');
    const events: InferenceGenerationEvent[] = [];
    const prompt = '<|im_start|>assistant\n';
    const codec = createQwen3_5Generation({
      prompt,
      tools: [{ type: 'function', function: {
        name: 'lookup_weather', description: '', parameters: { type: 'object', properties: { city: { type: 'string' } } },
      } }],
      emit: ({ event }) => events.push(event),
    });
    const streamer = new NativeProtocolStreamer({
      tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'],
      protocolTokens: qwen3_5ProtocolTokens,
      onText: ({ text }) => codec.text({ text }),
      onControl: ({ token }) => codec.control({ token }),
    });
    // Synthetic call content exercises the actual tokenizer and streamer. The
    // trailing IDs are independently pinned by the recorded native tool turns.
    const terminal = `\
</tool_call><|im_end|>
<|endoftext|>`;
    expect(tokenizer.encode(terminal, { add_special_tokens: false })).toEqual([248059, 248046, 198, 248044]);
    const output = `<tool_call><function=lookup_weather><parameter=city>Tokyo</parameter></function>${terminal}`;
    const ids = tokenizer.encode(output, { add_special_tokens: false }).map(BigInt);
    streamer.put([tokenizer.encode(prompt, { add_special_tokens: false }).map(BigInt)]);
    for (const batch of delivery === 'single' ? ids.map(id => [id]) : [ids]) streamer.put([batch]);
    streamer.end();
    codec.finish({ reason: 'unknown' });
    expect(events).toEqual([
      { type: 'tool_start', index: 0 },
      { type: 'tool_call', index: 0, toolCall: {
        id: expect.any(String), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
      } },
      { type: 'result', result: { type: 'finished', next: 'tool_results' } },
    ]);
    expect(harness.sessions).not.toHaveBeenCalled();
    expect(harness.bodyReads).toEqual([]);
  }, 20_000);
});
