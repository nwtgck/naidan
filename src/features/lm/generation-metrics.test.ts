import { describe, expect, it } from 'vitest';
import { readOllamaMetrics, readOpenAiMetrics } from './generation-metrics';

describe('provider metrics normalization', () => {
  it('converts Ollama nanoseconds without losing native counts', () => {
    expect(readOllamaMetrics({ value: { eval_count: 100, eval_duration: 2_500_000_000, prompt_eval_count: 512 } })).toMatchObject({ nInputTokens: 512, nOutputTokens: 100, speed: { measurement: 'ollama_eval', perSecond: 40, interval: { nUnits: 100, durationMs: 2500 } } });
  });

  it('uses llama.cpp timing counts instead of rounded rate and does not call prompt_n total input tokens', () => {
    expect(readOpenAiMetrics({ value: { timings: { predicted_n: 100, predicted_ms: 3000, predicted_per_second: 33.333, prompt_n: 3, cache_n: 900 } } })).toMatchObject({ nOutputTokens: 100, speed: { measurement: 'llama_cpp_predicted', perSecond: 100 / 3 } });
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
