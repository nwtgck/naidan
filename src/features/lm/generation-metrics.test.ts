import { describe, expect, it } from 'vitest';
import { readOllamaMetrics, readOpenAiMetrics, readOpenAiNativeTiming } from './generation-metrics';

describe('provider metrics normalization', () => {
  it('converts Ollama nanoseconds without losing native counts', () => {
    expect(readOllamaMetrics({ value: { eval_count: 100, eval_duration: 2_500_000_000, prompt_eval_count: 512 } })).toMatchObject({ nInputTokens: 512, nOutputTokens: 100, speed: { measurement: 'ollama_eval', perSecond: 40, interval: { nUnits: 100, durationMs: 2500 } } });
  });

  it('preserves a rounded native rate without inventing its interval or total input count', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 3000, predicted_per_second: 33.333, prompt_n: 3, cache_n: 900 } } })).toMatchObject({ nOutputTokens: 100, speed: { measurement: 'llama_cpp_predicted', perSecond: 33.333 } });
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 3000, predicted_per_second: 33.333 } } })?.speed.interval).toBeUndefined();
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 3000, prompt_n: 3 } } })?.nInputTokens).toBeUndefined();
  });

  it('uses a rate-only native extension without manufacturing a duration', () => {
    const metrics = readOpenAiMetrics({ value: { timings: { predicted_per_second: 42.6 } } });
    expect(metrics?.speed.perSecond).toBe(42.6);
    expect(metrics?.speed.interval).toBeUndefined();
  });

  it('labels usage divided by request time as client-request throughput', () => {
    const value = { usage: { completion_tokens: 50, prompt_tokens: 400 } };
    expect(readOpenAiMetrics({ value })).toBeUndefined();
    expect(readOpenAiMetrics({ value, requestDurationMs: 100 })).toBeUndefined();
    expect(readOpenAiMetrics({ value, requestDurationMs: 2000 })).toMatchObject({ nInputTokens: 400, nOutputTokens: 50, speed: { measurement: 'client_request', perSecond: 25 } });
  });

  it.each([null, 5, {}, { eval_count: '10', eval_duration: 1000 }, { eval_count: 10, eval_duration: 0 }, { eval_count: -1, eval_duration: 1000 }])('discards malformed optional Ollama telemetry: %j', value => {
    expect(readOllamaMetrics({ value })).toBeUndefined();
  });

  it('does not let invalid usage invalidate otherwise usable native timings', () => {
    expect(readOpenAiMetrics({ value: { usage: { completion_tokens: -1, prompt_tokens: 'x' }, timings: { predicted_n: 10, predicted_ms: 1000 } } })?.speed.perSecond).toBe(10);
    expect(readOpenAiMetrics({ value: { timings: { predicted_per_second: Infinity } } })).toBeUndefined();
  });
});

describe('llama.cpp-reported speed definitions', () => {
  it('matches the supplied server first-token exclusion without changing output counts', () => {
    // tools/server/tests/unit/test_metrics.py: 16 output tokens, 15 decode steps.
    const value = { timings: { predicted_n: 16, predicted_ms: 150, predicted_per_second: 100 }, usage: { prompt_tokens: 512 } };
    expect(readOpenAiMetrics({ value })).toEqual({
      nInputTokens: 512,
      nOutputTokens: 16,
      speed: { unit: 'tokens', measurement: 'llama_cpp_predicted', perSecond: 100, interval: { nUnits: 15, durationMs: 150 } },
    });
  });

  it('recognizes an inclusive compatible rate without forcing a modern denominator', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 16, predicted_ms: 150, predicted_per_second: 16 / 150 * 1000 } } }))
      .toMatchObject({ nOutputTokens: 16, speed: { perSecond: 16 / 150 * 1000, interval: { nUnits: 16, durationMs: 150 } } });
  });

  it('preserves the existing count-only convention when the producer supplies no rate', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 16, predicted_ms: 150 } } }))
      .toMatchObject({ nOutputTokens: 16, speed: { perSecond: 16 / 150 * 1000, interval: { nUnits: 16, durationMs: 150 } } });
  });

  it.each([0, 1_000_000, 1e12, undefined, null])('never displays a first-token spike, even at completion (rate=%s)', predicted_per_second => {
    const value = { timings: { predicted_n: 1, predicted_ms: 0.001, predicted_per_second }, usage: { completion_tokens: 1 } };
    expect(readOpenAiMetrics({ value, requestDurationMs: 2000 })).toBeUndefined();
    expect(readOpenAiNativeTiming({ value })).toMatchObject({ nOutputTokens: 1, durationMs: 0.001, metrics: undefined });
  });

  it.each([0, null, -1, '100', NaN, Infinity])('does not resurrect an explicit unusable rate using counts or usage (%s)', predicted_per_second => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 0.001, predicted_per_second }, usage: { completion_tokens: 100 } }, requestDurationMs: 1000 })).toBeUndefined();
  });

  it('preserves an unfamiliar reported rate, but refuses a contradictory interval', () => {
    const metrics = readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 2000, predicted_per_second: 42.6 } } });
    expect(metrics).toMatchObject({ nOutputTokens: 100, speed: { perSecond: 42.6 } });
    expect(metrics?.speed.interval).toBeUndefined();
  });

  it('does not clip genuinely high rates with a measurable count and duration', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 1_000_001, predicted_ms: 1000, predicted_per_second: 1_000_000 } } }))
      .toMatchObject({ speed: { perSecond: 1_000_000, interval: { nUnits: 1_000_000, durationMs: 1000 } } });
  });

  it('does not guess an interval when precision makes both definitions indistinguishable', () => {
    const metrics = readOpenAiMetrics({ value: { timings: { predicted_n: 1e12, predicted_ms: 1000, predicted_per_second: 1e12 } } });
    expect(metrics?.speed.perSecond).toBe(1e12);
    expect(metrics?.speed.interval).toBeUndefined();
  });

  it('accepts a positive rate without counts and rejects a declared zero time', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_per_second: 100 } } })?.speed.perSecond).toBe(100);
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 0, predicted_per_second: 100 } } })).toBeUndefined();
  });

  it('keeps malformed extensions optional and does not lose standard usage', () => {
    for (const timings of [undefined, {}, null, 'bad', { predicted_n: 'bad', predicted_ms: -1 }]) {
      expect(readOpenAiNativeTiming({ value: { timings } })).toBeUndefined();
      expect(readOpenAiMetrics({ value: { timings, usage: { completion_tokens: 20 } }, requestDurationMs: 1000 })?.speed.measurement).toBe('client_request');
    }
  });
});
