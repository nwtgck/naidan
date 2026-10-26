import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createMetricsStreamForTest } from './generation-metrics-stream.test-support';

function native({ n, ms, rate }: { n: number, ms: number, rate: number }) {
  return { predicted_n: n, predicted_ms: ms, predicted_per_second: rate };
}

describe('OpenAI live generation speed stability', () => {
  it.each([0, 1_000_000])('hides the first-token spike, warms up on native time and seals the native rate (%s)', async initialRate => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    await flushPromises();
    // A slow prompt does not make a 1us generation interval measurable.
    now = 30000;
    stream.send({ value: { choices: [{ delta: { content: 'first' } }], timings: native({ n: 1, ms: 0.001, rate: initialRate }) } });
    await flushPromises();
    expect(observer).not.toHaveBeenCalled();
    now = 31000;
    stream.send({ value: { choices: [{ delta: { content: 'text without timings' } }] } });
    await flushPromises();
    expect(observer).not.toHaveBeenCalled();
    stream.send({ value: { choices: [{ delta: { content: 'second' } }], timings: native({ n: 2, ms: 10, rate: 100 }) } });
    await flushPromises();
    expect(observer).not.toHaveBeenCalled();
    now = 32000;
    stream.send({ value: { choices: [], timings: native({ n: 81, ms: 800, rate: 100 }) } });
    await flushPromises();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ metrics: expect.objectContaining({ nOutputTokens: 81, speed: expect.objectContaining({ perSecond: 100, interval: { nUnits: 80, durationMs: 800 } }) }) });
    now = 32001;
    stream.send({ value: { choices: [{ delta: {} }], timings: native({ n: 82, ms: 810, rate: 100 }) } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    now = 33000;
    stream.send({ value: { choices: [{}], timings: native({ n: 181, ms: 1800, rate: 100 }) } });
    await flushPromises();
    expect(observer).toHaveBeenCalledTimes(2);
    stream.send({ value: { choices: [{ finish_reason: 'stop' }], timings: native({ n: 201, ms: 2000, rate: 100 }) } });
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { nOutputTokens: 201, speed: { perSecond: 100, interval: { nUnits: 200, durationMs: 2000 } } } });
    expect(stream.fetcher).toHaveBeenCalledOnce();
    expect(stream.message.parts[0]).toMatchObject({ text: 'firsttext without timingssecond', completeness: 'complete' });
    void clock;
  });

  it.each(['terminal', 'tail', 'before_done'] as const)('accepts short completed native intervals via %s but never publishes them live', async position => {
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    const timings = native({ n: 2, ms: 10, rate: 100 });
    stream.send({ value: { choices: [{ delta: { content: 'ok' } }], timings } });
    await flushPromises();
    expect(observer).not.toHaveBeenCalled();
    switch (position) {
    case 'terminal':
      stream.send({ value: { choices: [{ finish_reason: 'stop' }], timings } });
      break;
    case 'tail':
      stream.send({ value: { choices: [{ finish_reason: 'stop' }] } });
      stream.send({ value: { choices: [], timings } });
      break;
    case 'before_done':
      stream.send({ value: { choices: [], timings } });
      stream.sendRaw({ text: 'data: [DONE]\n\n' });
      break;
    default: {
      const exhaustive: never = position;
      throw new Error(String(exhaustive));
    }
    }
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { nOutputTokens: 2, speed: { perSecond: 100, interval: { nUnits: 1, durationMs: 10 } } } });
    expect(observer).not.toHaveBeenCalled();
  });

  it.each([0, 1_000_000, null])('does not invent speed for a one-token terminal response (%s)', async rate => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    await flushPromises();
    stream.send({ value: { choices: [{ delta: { content: 'start' } }] } });
    await flushPromises();
    now = 2000;
    stream.send({ value: { choices: [{ delta: { content: 'end' }, finish_reason: 'stop' }], timings: { predicted_n: 1, predicted_ms: 0.001, predicted_per_second: rate }, usage: { completion_tokens: 1 } } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    expect(observer).not.toHaveBeenCalled();
    void clock;
  });

  it('does not let duplicate or backwards native samples keep a live value fresh', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    const timings = native({ n: 101, ms: 1000, rate: 100 });
    stream.send({ value: { choices: [{ delta: { content: 'output' } }], timings } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    now = 6000;
    stream.send({ value: { choices: [], timings } });
    stream.send({ value: { choices: [{ delta: {} }], timings: native({ n: 1, ms: 0.001, rate: 1e6 }) } });
    stream.send({ value: { choices: [{ delta: { content: 'no native metadata' } }] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    now = 7000;
    stream.send({ value: { choices: [], timings: native({ n: 201, ms: 2000, rate: 100 }) } });
    await flushPromises();
    expect(observer).toHaveBeenCalledTimes(2);
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toMatchObject({ generationMetrics: { speed: { perSecond: 100 } } });
    void clock;
  });

  it('clears a previous provisional total when the latest native metadata is explicitly unmeasurable', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [], timings: native({ n: 2, ms: 10, rate: 100 }) } });
    stream.send({ value: { choices: [], timings: native({ n: 3, ms: 20, rate: 0 }) } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
  });

  it.each([2, 3])('only seals a provisional native total when trailing usage still matches (%s)', async nCompleted => {
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { choices: [], timings: native({ n: 2, ms: 10, rate: 100 }) } });
    stream.send({ value: { choices: [], usage: { completion_tokens: nCompleted } } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    const result = await stream.result;
    expect(result.type).toBe('finished');
    if (nCompleted === 2) {
      expect(result).toMatchObject({ generationMetrics: { nOutputTokens: 2, speed: { perSecond: 100 } } });
    } else {
      expect(result).not.toHaveProperty('generationMetrics');
    }
    expect(observer).not.toHaveBeenCalled();
  });

  it('keeps the live native rate as a sample, not a final total or a usage-based replacement', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    using stream = createMetricsStreamForTest({ observer: vi.fn() });
    stream.send({ value: { choices: [{ delta: { content: 'native' } }], timings: native({ n: 101, ms: 1000, rate: 100 }) } });
    await flushPromises();
    now = 2000;
    stream.send({ value: { choices: [{ finish_reason: 'stop' }] } });
    stream.send({ value: { choices: [], usage: { completion_tokens: 101 } } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    void clock;
  });

  it('does not suppress real high speeds after a valid generation interval', async () => {
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    const timings = native({ n: 1_000_001, ms: 1000, rate: 1_000_000 });
    stream.send({ value: { choices: [{ delta: { content: 'fast' } }], timings } });
    await flushPromises();
    expect(observer.mock.calls[0]?.[0].metrics.speed.perSecond).toBe(1_000_000);
    stream.send({ value: { choices: [{ finish_reason: 'length' }], timings } });
    expect(await stream.result).toMatchObject({ type: 'interrupted', reason: 'limit', generationMetrics: { speed: { perSecond: 1_000_000 } } });
  });

  it('never turns a warmed native stream into a successful completion after cancellation', async () => {
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { choices: [{ delta: { content: 'unfinished' } }], timings: native({ n: 101, ms: 1000, rate: 100 }) } });
    await flushPromises();
    stream.controller.abort();
    expect(await stream.result).toMatchObject({ type: 'interrupted', reason: 'aborted' });
    expect(stream.fetcher).toHaveBeenCalledOnce();
  });
});
