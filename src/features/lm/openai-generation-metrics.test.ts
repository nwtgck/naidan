import { describe, expect, it } from 'vitest';
import { createTokenSpeedMeter, MIN_OBSERVED_INTERVAL_MS, aggregateGenerationMetrics } from '@/logic/generation-metrics/measurement';
import { readOpenAiMetrics } from './generation-metrics';
import { createOpenAiGenerationMetricsReader } from './openai-generation-metrics';

function snapshot({ n, ms, rate }: { n: number, ms: number, rate: number }) {
  return { timings: { predicted_n: n, predicted_ms: ms, predicted_per_second: rate } };
}

describe('per-call OpenAI speed readiness', () => {
  it('treats first-token native data as pending without publishing a massive initial rate', () => {
    const reader = createOpenAiGenerationMetricsReader();
    expect(reader.hasNativeTiming()).toBe(false);
    expect(reader.live({ value: snapshot({ n: 1, ms: 0.001, rate: 0 }), now: 0 })).toBeUndefined();
    expect(reader.hasNativeTiming()).toBe(true);
    expect(reader.live({ value: snapshot({ n: 2, ms: 10, rate: 100 }), now: 10000 })).toBeUndefined();
    expect(reader.live({ value: snapshot({ n: 80, ms: 799, rate: 79 / 799 * 1000 }), now: 11000 })).toBeUndefined();
    expect(reader.live({ value: snapshot({ n: 81, ms: MIN_OBSERVED_INTERVAL_MS, rate: 100 }), now: 12000 }))
      .toMatchObject({ nOutputTokens: 81, speed: { perSecond: 100, interval: { nUnits: 80, durationMs: 800 } } });
  });

  it('uses the same first-to-last definition and live readiness as the browser meter', () => {
    const reader = createOpenAiGenerationMetricsReader();
    const browser = createTokenSpeedMeter();
    for (let n = 1; n <= 101; n++) {
      const ms = (n - 1) * 10;
      browser.sample({ now: 20000 + ms });
      const server = reader.live({ value: snapshot({ n, ms: Math.max(0.001, ms), rate: n === 1 ? 0 : 100 }), now: 50000 + ms });
      const worker = browser.snapshot({ live: true });
      expect(server?.speed.perSecond).toBe(worker?.speed.perSecond);
      expect(server?.speed.interval).toEqual(worker?.speed.interval);
      expect(server?.nOutputTokens).toEqual(worker?.nOutputTokens);
    }
  });

  it('does not require 800ms for a valid final sample, and does not divide by the request clock', () => {
    const reader = createOpenAiGenerationMetricsReader();
    const value = snapshot({ n: 2, ms: 10, rate: 100 });
    expect(reader.live({ value, now: 30000 })).toBeUndefined();
    expect(reader.final({ value, requestDurationMs: 90000 })?.speed.perSecond).toBe(100);
  });

  it('clears provisional totals for explicit native zero instead of using usage fallback', () => {
    const reader = createOpenAiGenerationMetricsReader();
    expect(reader.final({ value: { ...snapshot({ n: 1, ms: 0.001, rate: 0 }), usage: { completion_tokens: 1 } }, requestDurationMs: 1000 })).toBeNull();
    expect(reader.final({ value: { usage: { completion_tokens: 20 } }, requestDurationMs: 2000 })).toBeUndefined();
    expect(reader.hasNativeTiming()).toBe(true);
  });

  it('keeps usage-only fallback when no native telemetry has been seen', () => {
    const reader = createOpenAiGenerationMetricsReader();
    expect(reader.live({ value: { choices: [] }, now: 1000 })).toBeUndefined();
    expect(reader.hasNativeTiming()).toBe(false);
    expect(reader.final({ value: { usage: { completion_tokens: 20 } }, requestDurationMs: 2000 }))
      .toMatchObject({ speed: { measurement: 'client_request', perSecond: 10 } });
  });

  it('gates rate-only extensions across observations without fabricating an interval', () => {
    const reader = createOpenAiGenerationMetricsReader();
    const value = { timings: { predicted_per_second: 42.6 } };
    expect(reader.live({ value, now: 10000 })).toBeUndefined();
    expect(reader.live({ value: {}, now: 20000 })).toBeUndefined();
    expect(reader.live({ value, now: 10799 })).toBeUndefined();
    const live = reader.live({ value, now: 10800 });
    expect(live?.speed.perSecond).toBe(42.6);
    expect(live?.speed.interval).toBeUndefined();
    expect(createOpenAiGenerationMetricsReader().final({ value, requestDurationMs: 1 })?.speed.perSecond).toBe(42.6);
  });

  it('does not use a rate-only observation clock to bypass a supplied short generation interval', () => {
    const reader = createOpenAiGenerationMetricsReader();
    reader.live({ value: { timings: { predicted_per_second: 50 } }, now: 0 });
    expect(reader.live({ value: snapshot({ n: 3, ms: 20, rate: 100 }), now: 10000 })).toBeUndefined();
  });

  it('does not refresh known duplicate native counters or accept backwards progress', () => {
    const reader = createOpenAiGenerationMetricsReader();
    const value = snapshot({ n: 101, ms: 1000, rate: 100 });
    expect(reader.live({ value, now: 1000 })).toBeDefined();
    expect(reader.live({ value, now: 7000 })).toBeUndefined();
    expect(reader.live({ value: snapshot({ n: 100, ms: 1010, rate: 99 / 1.01 }), now: 8000 })).toBeUndefined();
    expect(reader.live({ value: snapshot({ n: 102, ms: 999, rate: 101 / 0.999 }), now: 9000 })).toBeUndefined();
    expect(reader.final({ value: snapshot({ n: 2, ms: 10, rate: 100 }), requestDurationMs: 10000 })).toBeNull();
    expect(reader.live({ value: snapshot({ n: 201, ms: 2000, rate: 100 }), now: 11000 })?.speed.perSecond).toBe(100);
    expect(reader.final({ value: snapshot({ n: 201, ms: 2000, rate: 100 }), requestDurationMs: 11000 })?.speed.perSecond).toBe(100);
  });

  it('does not let malformed or zero-rate samples poison later valid progress', () => {
    const reader = createOpenAiGenerationMetricsReader();
    const valid = snapshot({ n: 101, ms: 1000, rate: 100 });
    expect(reader.live({ value: { timings: { predicted_n: 1_000_000, predicted_ms: 1e9, predicted_per_second: null } }, now: 0 })).toBeUndefined();
    expect(reader.live({ value: valid, now: 1000 })?.speed.perSecond).toBe(100);
    expect(reader.live({ value: snapshot({ n: 1_000_001, ms: 1e9, rate: 0 }), now: 2000 })).toBeUndefined();
    expect(reader.live({ value: snapshot({ n: 201, ms: 2000, rate: 100 }), now: 3000 })?.speed.perSecond).toBe(100);
  });

  it('accepts increasing counts at the same time for speculative batches', () => {
    const reader = createOpenAiGenerationMetricsReader();
    expect(reader.live({ value: snapshot({ n: 101, ms: 1000, rate: 100 }), now: 1000 })).toBeDefined();
    expect(reader.live({ value: snapshot({ n: 105, ms: 1000, rate: 104 }), now: 1001 }))
      .toMatchObject({ nOutputTokens: 105, speed: { perSecond: 104, interval: { nUnits: 104 } } });
  });

  it('isolates readiness and native preference between model calls', () => {
    const first = createOpenAiGenerationMetricsReader();
    first.live({ value: snapshot({ n: 501, ms: 5000, rate: 100 }), now: 5000 });
    const second = createOpenAiGenerationMetricsReader();
    expect(second.hasNativeTiming()).toBe(false);
    expect(second.live({ value: snapshot({ n: 2, ms: 10, rate: 100 }), now: 10000 })).toBeUndefined();
    expect(second.final({ value: snapshot({ n: 2, ms: 10, rate: 100 }), requestDurationMs: 10 })?.speed.perSecond).toBe(100);
  });

  it.each([NaN, Infinity, -Infinity])('does not publish with an invalid observation timestamp (%s)', now => {
    const reader = createOpenAiGenerationMetricsReader();
    expect(reader.live({ value: snapshot({ n: 101, ms: 1000, rate: 100 }), now })).toBeUndefined();
  });
});

describe('server generation aggregation', () => {
  it('subtracts the initial token for each native call, not once per turn', () => {
    const first = readOpenAiMetrics({ value: snapshot({ n: 21, ms: 500, rate: 40 }) });
    const second = readOpenAiMetrics({ value: snapshot({ n: 181, ms: 3000, rate: 60 }) });
    expect(aggregateGenerationMetrics({ calls: [first, second] }))
      .toMatchObject({ nOutputTokens: 202, speed: { perSecond: 200 / 3500 * 1000, interval: { nUnits: 200, durationMs: 3500 } } });
  });

  it('does not aggregate incompatible, unknown or rounded denominator definitions', () => {
    const exclusive = readOpenAiMetrics({ value: snapshot({ n: 101, ms: 1000, rate: 100 }) });
    const inclusive = readOpenAiMetrics({ value: snapshot({ n: 101, ms: 1000, rate: 101 }) });
    const unknown = readOpenAiMetrics({ value: snapshot({ n: 101, ms: 1000, rate: 42.6 }) });
    const rounded = readOpenAiMetrics({ value: snapshot({ n: 101, ms: 3000, rate: 33.333 }) });
    for (const calls of [[exclusive, inclusive], [inclusive, exclusive], [unknown, unknown], [rounded, rounded]]) {
      expect(aggregateGenerationMetrics({ calls })).toBeUndefined();
    }
  });

  it('continues aggregating homogeneous count-only compatible calls', () => {
    const one = readOpenAiMetrics({ value: { timings: { predicted_n: 20, predicted_ms: 500 } } });
    const two = readOpenAiMetrics({ value: { timings: { predicted_n: 180, predicted_ms: 3000 } } });
    expect(aggregateGenerationMetrics({ calls: [one, two] })?.speed.perSecond).toBe(200 / 3500 * 1000);
  });
});
