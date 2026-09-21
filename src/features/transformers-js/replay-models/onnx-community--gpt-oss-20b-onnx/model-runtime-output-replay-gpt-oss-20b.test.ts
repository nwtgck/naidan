// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveFor, start, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import { createGptOssGeneration } from '@/features/transformers-js/models/gpt-oss-generation';
import { observeNativeStreamer } from '@/features/transformers-js/worker/native-streamer-capture';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';

const modelId = 'onnx-community/gpt-oss-20b-ONNX';
installRawReplay({ evidence: undefined });
afterEach(() => {
  vi.doUnmock('@huggingface/transformers'); vi.resetModules();
});

describe('GPT-OSS native output with the Production TextStreamer and original tokenizer', () => {
  it.each(['single', 'batch'] as const)('preserves native part boundaries with %s token delivery', async delivery => {
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    // Import the same adapter against the actual, freshly evaluated Production
    // artifact. No fake TextStreamer, session or model output is used below.
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const events: InferenceGenerationEvent[] = [];
    const parser = createGptOssGeneration({ emit: ({ event }) => {
      events.push(event);
    } });
    const streamer = new NativeProtocolStreamer({ protocolTokens: undefined, tokenizer: tokenizer as unknown as ConstructorParameters<typeof NativeProtocolStreamer>[0]['tokenizer'],
      onText: ({ text }) => parser.text({ text }), onControl: ({ token }) => parser.control({ token }),
    });
    const prompt = tokenizer.encode('<|start|>assistant', { add_special_tokens: false }).map(BigInt);
    // Synthetic generation IDs, not a captured inference. The framing/text
    // expectations are independent of the decoder under test.
    const output = `<|channel|>analysis<|message|>  確認🙂\n<|end|><|start|>assistant<|channel|>final<|message|><think>literal</think>Answer  <|return|>`;
    const ids = tokenizer.encode(output, { add_special_tokens: false }).map(BigInt);
    streamer.put([prompt]);
    switch (delivery) {
    case 'single': for (const id of ids) streamer.put([[id]]); break;
    case 'batch': streamer.put([ids]); break;
    default: { const exhaustive: never = delivery; throw new Error(`Unhandled delivery: ${exhaustive}`); }
    }
    streamer.end(); parser.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start')).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'part_start', index: 1, kind: 'text' },
    ]);
    expect(events.filter(e => e.type === 'text_delta').filter(e => e.index === 0).map(e => e.text).join('')).toBe('  確認🙂\n');
    expect(events.filter(e => e.type === 'text_delta').filter(e => e.index === 1).map(e => e.text).join('')).toBe('<think>literal</think>Answer  ');
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);

  it.each(['answer', 'call', 'partial'] as const)('uses native events in the real model helper for %s output', async shape => {
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    vi.doMock('@huggingface/transformers', () => harness.runtime);
    const { generateGptOss } = await import('@/features/transformers-js/models/gpt-oss');
    const { NativeProtocolStreamer } = await import('@/features/transformers-js/models/native-protocol-streamer');
    const events: InferenceGenerationEvent[] = [];
    const onChunk = vi.fn(); const onToolCalls = vi.fn();
    const stoppingCriteria = { reset: vi.fn(), interrupt: vi.fn() };
    const setNativeStreamAvailability = vi.fn(); const recordNativeStream = vi.fn();
    const output = (() => {
      switch (shape) {
      case 'answer': return `\
<|channel|>analysis<|message|>  R
<|end|><|start|>assistant<|channel|>final<|message|>A  <|return|>`;
      case 'call': return ' to=functions.calculator<|channel|>commentary<|message|> { "expression": "17 * 23" } <|call|>';
      case 'partial': return '<|channel|>analysis<|message|>  未完🙂\n';
      default: { const exhaustive: never = shape; throw new Error(`Unhandled output: ${exhaustive}`); }
      }
    })();
    const generated = tokenizer.encode(output, { add_special_tokens: false }).map(BigInt);
    const cache = await generateGptOss({
      model: { config: {} } as Parameters<typeof generateGptOss>[0]['model'],
      tokenizer: tokenizer as unknown as Parameters<typeof generateGptOss>[0]['tokenizer'],
      messages: [{ role: 'user', content: 'Run the synthetic example.' }],
      onChunk, onToolCalls, params: undefined, tools: undefined,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria,
      onInputPrepared: undefined, onGenerationEvent: ({ event }) => {
        events.push(event);
      },
      generateWithModel: async ({ streamer }) => {
        expect(streamer).toBeInstanceOf(NativeProtocolStreamer);
        const observation = observeNativeStreamer({ streamer, streamerPrototype: NativeProtocolStreamer.prototype,
          capture: { setNativeStreamAvailability, recordNativeStream },
        });
        try {
          // The model session is replaced by fixed tokenizer IDs; the Production
          // streamer and generateGptOss parser/cache branch are the real code.
          streamer.put([[1n]]); streamer.put([generated]); streamer.end();
        } finally {
          observation.restore();
        }
        expect(Object.hasOwn(streamer, 'put')).toBe(false);
        return { past_key_values: undefined };
      },
    });
    expect(cache).toBeUndefined();
    expect(onChunk).not.toHaveBeenCalled(); expect(onToolCalls).not.toHaveBeenCalled();
    expect(setNativeStreamAvailability).toHaveBeenLastCalledWith({ availability: { status: 'available', restoration: 'restored' } });
    expect(recordNativeStream).toHaveBeenCalledWith(expect.objectContaining({ operation: 'on_finalized_text', phase: 'entering' }));
    switch (shape) {
    case 'answer':
      expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe(`\
  R
A  `);
      expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
      expect(stoppingCriteria.interrupt).not.toHaveBeenCalled();
      break;
    case 'call': {
      const calls = events.filter(e => e.type === 'tool_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.toolCall.function).toEqual({ name: 'calculator', arguments: ' { "expression": "17 * 23" } ' });
      expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'tool_results' } });
      expect(stoppingCriteria.interrupt).toHaveBeenCalledOnce();
      break;
    }
    case 'partial':
      expect(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe('  未完🙂\n');
      expect(events.at(-2)).toEqual({ type: 'part_end', index: 0, completeness: 'partial' });
      expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
      break;
    default: { const exhaustive: never = shape; throw new Error(`Unhandled output: ${exhaustive}`); }
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]); expect(harness.transport).not.toHaveBeenCalled();
  }, 20_000);

});
