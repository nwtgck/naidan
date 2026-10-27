import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createMetricsStreamForTest, useMetricsFakeTimersForTest } from './generation-metrics-stream.test-support';

const timings = { predicted_n: 100, predicted_ms: 2500, predicted_per_second: 40 };

describe('generation telemetry on remote streams', () => {
  it('reads llama.cpp statistics on the terminal choice without waiting for EOF', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], timings } });
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { nOutputTokens: 100, speed: { measurement: 'llama_cpp_predicted', perSecond: 40 } } });
    expect(stream.message.parts).toMatchObject([{ text: 'hello', completeness: 'complete' }]);
    expect(stream.canceled).toHaveBeenCalledOnce();
    expect(stream.fetcher).toHaveBeenCalledOnce();
    const body = stream.fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(String(body))).not.toHaveProperty('stream_options');
  });

  it('reads llama.cpp statistics on a choices-empty tail after finish_reason', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] } });
    stream.send({ value: { choices: [], timings, usage: { prompt_tokens: 512, completion_tokens: 100 } } });
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { nInputTokens: 512, speed: { perSecond: 40 } } });
  });

  it('bounds a missing statistics tail without retrying or losing accepted output', async () => {
    using timers = useMetricsFakeTimersForTest();
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] } });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(201);
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    expect(stream.message.parts).toMatchObject([{ text: 'done', completeness: 'complete' }]);
    expect(stream.canceled).toHaveBeenCalledOnce();
    expect(stream.fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('treats malformed tail metadata and post-finish content as optional, not more output', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] } });
    stream.send({ value: { choices: [{ delta: { content: 'injected' } }], timings } });
    stream.sendRaw({ text: 'data: {invalid}\n\n' });
    stream.close();
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    expect(stream.message.parts).toMatchObject([{ text: 'done' }]);
  });

  it('limits a metadata flood by event count', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ finish_reason: 'stop' }] } });
    for (let n = 0; n < 18; n++) {
      stream.send({ value: { choices: [], usage: {} } });
    }
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    expect(stream.canceled).toHaveBeenCalledOnce();
  });

  it('respects a user abort while waiting for the final statistics', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] } });
    await flushPromises();
    stream.controller.abort();
    expect(await stream.result).toMatchObject({ type: 'interrupted', reason: 'aborted' });
  });

  it('publishes live text and switches to native tokens at completion', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { choices: [{ delta: { content: 'start' } }] } });
    await flushPromises();
    now = 1000;
    stream.send({ value: { choices: [{ delta: { content: 'あ🙂' } }] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ metrics: expect.objectContaining({ speed: expect.objectContaining({ unit: 'characters', perSecond: 2 }) }) });
    now = 1100;
    stream.send({ value: { choices: [{ delta: { content: 'extra' } }] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    stream.send({ value: { choices: [{ finish_reason: 'stop' }], timings } });
    expect(await stream.result).toMatchObject({ generationMetrics: { speed: { unit: 'tokens', perSecond: 40 } } });
    void clock;
  });

  it('uses request time, not metadata wait time, for usage-only fallback', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    using stream = createMetricsStreamForTest();
    await flushPromises();
    now = 2000;
    stream.send({ value: { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] } });
    await flushPromises();
    now = 2100;
    stream.send({ value: { choices: [], usage: { completion_tokens: 40 } } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toMatchObject({ generationMetrics: { speed: { measurement: 'client_request', perSecond: 20 } } });
    void clock;
  });

  it('does not label an unexpected EOF successful even after live updates', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'start' } }] } });
    await flushPromises();
    now = 1000;
    stream.send({ value: { choices: [{ delta: { content: 'end' } }] } });
    stream.close();
    expect(await stream.result).toEqual({ type: 'interrupted', reason: 'unknown' });
    void clock;
  });

  it('does not seal an intermediate metadata total when more content follows it', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [], timings } });
    stream.send({ value: { choices: [{ delta: { content: 'continued' }, finish_reason: 'stop' }] } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
  });

  it('preserves a token-limit result with valid server telemetry', async () => {
    using stream = createMetricsStreamForTest();
    stream.send({ value: { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }], timings } });
    expect(await stream.result).toMatchObject({ type: 'interrupted', reason: 'limit', generationMetrics: { speed: { perSecond: 40 } } });
  });

  it('reports Ollama live characters and final native evaluation speed', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ protocol: 'ndjson', observer });
    stream.send({ value: { message: { role: 'assistant', content: 'start' }, done: false } });
    await flushPromises();
    now = 1000;
    stream.send({ value: { message: { role: 'assistant', content: 'abc', thinking: 'def' }, done: false } });
    await flushPromises();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ metrics: expect.objectContaining({ speed: expect.objectContaining({ perSecond: 6, unit: 'characters' }) }) });
    stream.send({ value: { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 50, eval_duration: 2_000_000_000 } });
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { speed: { measurement: 'ollama_eval', perSecond: 25 } } });
    void clock;
  });

  it('never fails valid Ollama output because of broken telemetry or an observer', async () => {
    using stream = createMetricsStreamForTest({
      protocol: 'ndjson',
      observer: () => {
        throw new Error('optional observer');
      },
    });
    stream.send({ value: { message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', eval_count: 'broken', eval_duration: -1 } });
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
  });
});

describe('OpenAI native timing priority during generation', () => {
  it.each([
    { choices: [] },
    { choices: [{ delta: {} }] },
    { choices: [{}] },
  ])('accepts native updates without a text delta: %j', async shape => {
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { ...shape, timings: { predicted_n: 40, predicted_ms: 1000 } } });
    await flushPromises();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ metrics: expect.objectContaining({ speed: expect.objectContaining({ unit: 'tokens', perSecond: 40 }) }) });
    stream.send({ value: { choices: [{ finish_reason: 'stop' }], timings: { predicted_n: 80, predicted_ms: 2000 } } });
    expect(await stream.result).toMatchObject({ type: 'finished', generationMetrics: { nOutputTokens: 80 } });
  });

  it('upgrades immediately, never regresses to characters, and does not refresh a missing native sample', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { choices: [{ delta: { content: 'start' } }] } });
    await flushPromises();
    now = 1000;
    stream.send({ value: { choices: [{ delta: { content: 'abc' } }] } });
    await flushPromises();
    expect(observer.mock.calls[0]?.[0].metrics.speed.unit).toBe('characters');
    now = 1010;
    stream.send({ value: { choices: [{ delta: { content: 'native' } }], timings: { predicted_n: 40, predicted_ms: 1000 } } });
    await flushPromises();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls[1]?.[0].metrics.speed.unit).toBe('tokens');
    now = 3000;
    stream.send({ value: { choices: [{ delta: { content: 'missing' } }], timings: { predicted_n: 'invalid' } } });
    stream.send({ value: { choices: [] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledTimes(2);
    now = 4000;
    stream.send({ value: { choices: [{ delta: { content: 'back' } }], timings: { predicted_n: 90, predicted_ms: 3000 } } });
    await flushPromises();
    expect(observer).toHaveBeenCalledTimes(3);
    stream.send({ value: { choices: [{ finish_reason: 'stop' }] } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    // Keep the already published live value in the state layer as last_sample,
    // never fabricate a final total or replace it with character throughput.
    expect(await stream.result).toEqual({ type: 'finished', next: 'user' });
    void clock;
  });

  it('does not keep character estimates alive with placeholder or metadata-only events', async () => {
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observer = vi.fn();
    using stream = createMetricsStreamForTest({ observer });
    stream.send({ value: { choices: [{ delta: { content: 'start' } }] } });
    await flushPromises();
    now = 1000;
    stream.send({ value: { choices: [{ delta: { content: 'abc' } }] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    now = 6000;
    stream.send({ value: { choices: [{ delta: {} }] } });
    stream.send({ value: { choices: [] } });
    await flushPromises();
    expect(observer).toHaveBeenCalledOnce();
    stream.send({ value: { choices: [{ finish_reason: 'stop' }] } });
    stream.sendRaw({ text: 'data: [DONE]\n\n' });
    await stream.result;
    void clock;
  });
});
