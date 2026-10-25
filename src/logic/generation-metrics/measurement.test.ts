import { describe, expect, it, vi } from 'vitest';
import { parseGenerationMetrics, reportGenerationMetrics } from '@/01-models/generation-metrics';
import { aggregateGenerationMetrics, createMetricsReporter, createReceivedTextMeter, createTokenMetrics, createTokenSpeedMeter } from './measurement';

function native({ n = 20, ms = 500 }: { n?: number, ms?: number } = {}) {
  return createTokenMetrics({ measurement: 'ollama_eval', nOutputTokens: n, nMeasuredTokens: n, durationMs: ms })!;
}

describe('generation speed measurement', () => {
  it('uses N - 1 sample intervals, excludes startup, and delays unstable live readings', () => {
    const meter = createTokenSpeedMeter();
    expect(meter.snapshot({ live: false })).toBeUndefined();
    meter.sample({ now: 10_000 });
    expect(meter.snapshot({ live: false })).toBeUndefined();
    meter.sample({ now: 10_100 });
    expect(meter.snapshot({ live: true })).toBeUndefined();
    expect(meter.snapshot({ live: false })).toMatchObject({ nOutputTokens: 2, speed: { perSecond: 10, interval: { nUnits: 1, durationMs: 100 } } });
    meter.sample({ now: 11_000 });
    expect(meter.snapshot({ live: true })).toMatchObject({ nOutputTokens: 3, speed: { perSecond: 2, interval: { nUnits: 2, durationMs: 1000 } } });
  });

  it('does not publish zero-length or backwards token intervals', () => {
    for (const last of [100, 99]) {
      const meter = createTokenSpeedMeter();
      meter.sample({ now: 100 });
      meter.sample({ now: last });
      expect(meter.snapshot({ live: false })).toBeUndefined();
    }
  });

  it('counts Unicode code points per field, not chunks or UTF-16 units', () => {
    const meter = createReceivedTextMeter();
    meter.observe({ fields: [{ key: 'text', text: 'first🙂' }], now: 100 });
    meter.observe({ fields: [{ key: 'text', text: 'あ🙂' }, { key: 'reasoning', text: '界' }], now: 1100 });
    expect(meter.snapshot()).toMatchObject({ speed: { unit: 'characters', perSecond: 3, interval: { nUnits: 3, durationMs: 1000 } } });
    meter.observe({ fields: [{ key: 'text', text: '' }], now: 9100 });
    expect(meter.snapshot()?.speed.perSecond).toBe(3);
  });

  it('does not double count a surrogate pair split across events or mix separate fields', () => {
    const meter = createReceivedTextMeter();
    meter.observe({ fields: [{ key: 'text', text: 'start' }], now: 0 });
    meter.observe({ fields: [{ key: 'text', text: '\ud83d' }, { key: 'tool:0', text: '\ud83d' }], now: 500 });
    meter.observe({ fields: [{ key: 'text', text: '\ude42' }, { key: 'tool:0', text: '\ude42' }, { key: 'tool:1', text: '\ude42' }], now: 1000 });
    expect(meter.snapshot()?.speed.interval?.nUnits).toBe(3);
  });

  it('does not invent throughput from a single burst or very short observation', () => {
    const meter = createReceivedTextMeter();
    meter.observe({ fields: [{ key: 'text', text: 'a'.repeat(1000) }], now: 0 });
    expect(meter.snapshot()).toBeUndefined();
    meter.observe({ fields: [{ key: 'text', text: 'b' }], now: 20 });
    expect(meter.snapshot()).toBeUndefined();
  });

  it('throttles live notifications without suppressing a later measurement', () => {
    let time = 0;
    const observer = vi.fn();
    const report = createMetricsReporter({ observer, now: () => time });
    report({ metrics: undefined });
    report({ metrics: native() });
    time = 999;
    report({ metrics: native() });
    time = 1000;
    report({ metrics: native() });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('contains synchronous and asynchronous observer failures', async () => {
    expect(() => reportGenerationMetrics({
      observer: () => {
        throw new Error('observer');
      },
      metrics: native(),
    })).not.toThrow();
    reportGenerationMetrics({
      observer: async () => {
        throw new Error('async observer');
      },
      metrics: native(),
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it.each([NaN, Infinity, -1, 0])('rejects invalid rates: %s', perSecond => {
    expect(parseGenerationMetrics({ value: { speed: { unit: 'tokens', measurement: 'ollama_eval', perSecond } } })).toBeUndefined();
  });

  it('rejects mismatched units, inconsistent rate/interval and invalid counts', () => {
    expect(parseGenerationMetrics({ value: { speed: { unit: 'characters', measurement: 'ollama_eval', perSecond: 1 } } })).toBeUndefined();
    expect(parseGenerationMetrics({ value: { speed: { unit: 'tokens', measurement: 'ollama_eval', perSecond: 10, interval: { nUnits: 20, durationMs: 1000 } } } })).toBeUndefined();
    for (const nOutputTokens of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(parseGenerationMetrics({ value: { ...native(), nOutputTokens } })).toBeUndefined();
    }
  });

  it('weights complete homogeneous intervals rather than averaging speeds', () => {
    const combined = aggregateGenerationMetrics({ calls: [native(), native({ n: 180, ms: 3000 })] });
    expect(combined?.nOutputTokens).toBe(200);
    expect(combined?.speed.perSecond).toBeCloseTo(200 / 3.5);
    expect(combined?.speed.interval).toEqual({ nUnits: 200, durationMs: 3500 });
    expect(combined?.nInputTokens).toBeUndefined();
  });

  it('adds sampled intervals, not total output tokens, across model calls', () => {
    const one = createTokenMetrics({ measurement: 'worker_sample_interval', nOutputTokens: 11, nMeasuredTokens: 10, durationMs: 1000 });
    const two = createTokenMetrics({ measurement: 'worker_sample_interval', nOutputTokens: 21, nMeasuredTokens: 20, durationMs: 1000 });
    expect(aggregateGenerationMetrics({ calls: [one, two] })).toMatchObject({ nOutputTokens: 32, speed: { perSecond: 15, interval: { nUnits: 30 } } });
  });

  it('refuses mixed, incomplete, client-clock and rate-only aggregation', () => {
    const client = createTokenMetrics({ measurement: 'client_request', nOutputTokens: 20, nMeasuredTokens: 20, durationMs: 1000 });
    const worker = createTokenMetrics({ measurement: 'worker_sample_interval', nOutputTokens: 20, nMeasuredTokens: 19, durationMs: 1000 });
    const rateOnly = createTokenMetrics({ measurement: 'ollama_eval', perSecond: 20 });
    for (const calls of [[native()], [native(), undefined], [undefined, native()], [native(), worker], [client, client], [rateOnly, rateOnly]]) {
      expect(aggregateGenerationMetrics({ calls })).toBeUndefined();
    }
  });
});
