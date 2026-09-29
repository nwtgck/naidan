/* eslint-disable no-restricted-imports -- Test the actual upstream TextStreamer with a bounded tokenizer platform. */
import { TextStreamer, type PreTrainedTokenizer } from '@huggingface/transformers';
import { describe, expect, it, vi } from 'vitest';
import { createToolStreamDecodeView } from './standard-tool-stream-decoder';
import { observeNativeStreamer } from './worker/native-streamer-capture';

function tokenizerFixture() {
  const words = new Map([[7, '<|im_end|>'], [10, '<|tool_call_start|>'], [11, '<|tool_call_end|>'], [20, '[lookup_weather(city="Tokyo")]'], [21, 'prompt'], [99, '<other>']]);
  const tokenizer = {
    all_special_ids: [7, 10, 11, 99],
    decode: vi.fn(function(this: unknown, tokens: (number | bigint)[]) {
      expect(this).toBe(tokenizer);
      if (tokens.length === 0) throw new Error('Upstream decode rejects empty token arrays');
      return tokens.map(token => words.get(Number(token)) ?? '').join('');
    }),
  };
  return tokenizer;
}

describe('selective tool stream decoding', () => {
  it.each(['single', 'batched'] as const)('preserves framing, not other specials, with %s native put and unchanged capture input', grouping => {
    const original = tokenizerFixture();
    const tokenizer = original as unknown as PreTrainedTokenizer;
    const beforeSpecials = [...original.all_special_ids];
    const view = createToolStreamDecodeView({ tokenizer, preservedDelimiterIds: [10, 11] });
    const chunks: string[] = [];
    const entered: unknown[] = [];
    const streamer = new TextStreamer(view, { skip_prompt: true, skip_special_tokens: false, callback_function: (text: string) => chunks.push(text) });
    const hook = observeNativeStreamer({ streamer, streamerPrototype: TextStreamer.prototype, capture: {
      setNativeStreamAvailability: vi.fn(),
      recordNativeStream: ({ operation, phase, args }) => {
        if (operation === 'put' && phase === 'entering') entered.push(structuredClone(args));
      },
    } });
    const puts = grouping === 'single' ? [[21n], [10n], [20n], [11n], [7n], [99n]] : [[21n], [10n, 20n, 11n, 7n, 99n]];
    try {
      for (const tokens of puts) streamer.put([tokens]);
      streamer.end();
    } finally {
      hook.restore();
    }
    expect(chunks.join('')).toBe('<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>');
    expect(entered).toEqual(puts.map(tokens => [[tokens]]));
    expect(original.all_special_ids).toEqual(beforeSpecials);
    expect(Object.getPrototypeOf(streamer)).toBe(TextStreamer.prototype);
    expect(Object.hasOwn(streamer, 'put')).toBe(false);
    expect(() => Reflect.set(view, 'all_special_ids', [])).toThrow('read-only');
  });

  it('rejects malformed delimiter and special token IDs', () => {
    const tokenizer = tokenizerFixture() as unknown as PreTrainedTokenizer;
    for (const ids of [[10], [10, 10], [-1, 11], [NaN, 11]]) {
      expect(() => createToolStreamDecodeView({ tokenizer, preservedDelimiterIds: ids })).toThrow('Invalid admitted');
    }
  });
});
