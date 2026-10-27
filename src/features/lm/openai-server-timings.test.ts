import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { LlamaCppServerTimingsMode } from '@/01-models/types';
import type { GenerationMetricsObserver } from '@/01-models/generation-metrics';
import type { LmFetch } from './fetch';
import { OpenAIProvider } from './openai';
import { consumeProviderGenerationForTest } from './provider.test-support';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useMetricsFakeTimersForTest } from './generation-metrics-stream.test-support';

const props = { default_generation_settings: { params: { timings_per_token: false } } };

function completion() {
  return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"timings":{"predicted_n":40,"predicted_ms":1000}}\n\n');
}

function run({ fetcher, mode = 'auto', signal, observer = vi.fn() }: { fetcher: LmFetch, mode?: LlamaCppServerTimingsMode, signal?: AbortSignal, observer?: GenerationMetricsObserver | null }) {
  const provider = new OpenAIProvider({ endpoint: 'http://localhost:8080/proxy/v1', headers: [['Authorization', 'Bearer token']], fetcher, llamaCppServerTimings: mode });
  return consumeProviderGenerationForTest({
    provider,
    request: { debug: undefined, messages: [], model: 'fixture', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal, onGenerationMetrics: observer ?? undefined },
  });
}

describe('OpenAI-compatible per-token timings requests', () => {
  it('detects through the same fetch and auth context, then sends exactly one augmented generation', async () => {
    const fetcher = vi.fn<LmFetch>().mockResolvedValueOnce(Response.json(props)).mockResolvedValueOnce(completion());
    const { result } = await run({ fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(['http://localhost:8080/proxy/props', expect.objectContaining({ method: 'GET', headers: [['Authorization', 'Bearer token']], redirect: 'error' })]);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('http://localhost:8080/proxy/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture', stream: true, timings_per_token: true });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('stream_options');
    expect(result).toMatchObject({ type: 'finished', generationMetrics: { speed: { measurement: 'llama_cpp_predicted', perSecond: 40 } } });
  });

  it.each(['enabled', 'disabled'] as const)('uses %s without probing', async mode => {
    const fetcher = vi.fn<LmFetch>(async () => completion());
    await run({ fetcher, mode });
    expect(fetcher).toHaveBeenCalledOnce();
    const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    if (mode === 'enabled') {
      expect(body).toHaveProperty('timings_per_token', true);
    } else {
      expect(body).not.toHaveProperty('timings_per_token');
    }
  });

  it('does not add active measurement when there is no observer', async () => {
    const fetcher = vi.fn<LmFetch>(async () => completion());
    await run({ fetcher, mode: 'enabled', observer: null });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty('timings_per_token');
  });

  it('keeps a failed props check nonfatal and never resends generation', async () => {
    const fetcher = vi.fn<LmFetch>().mockRejectedValueOnce(new Error('CORS blocked props')).mockResolvedValueOnce(completion());
    const { node, result } = await run({ fetcher });
    expect(node.parts).toMatchObject([{ text: 'ok' }]);
    expect(result.type).toBe('finished');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).not.toHaveProperty('timings_per_token');
  });

  it('does not retry a rejected forced extension', async () => {
    const events = useGlobalEvents();
    using cleanup = {
      [Symbol.dispose]() {
        events.clearEvents();
      },
    };
    const fetcher = vi.fn<LmFetch>(async () => Response.json({ error: { message: 'unknown parameter: timings_per_token' } }, { status: 400 }));
    expect((await run({ fetcher, mode: 'enabled' })).result).toMatchObject({ type: 'error' });
    expect(fetcher).toHaveBeenCalledOnce();
    void cleanup;
  });

  it('cancels the caller promptly while leaving a bounded shared probe and sending no POST', async () => {
    using timers = useMetricsFakeTimersForTest();
    const fetcher = vi.fn<LmFetch>(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = run({ fetcher, signal: controller.signal });
    await flushPromises();
    controller.abort();
    expect((await pending).result).toMatchObject({ type: 'interrupted', reason: 'aborted' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('starts ordinary generation after the short budget and uses late detection on the next request', async () => {
    using timers = useMetricsFakeTimersForTest();
    const gate = Promise.withResolvers<Response>();
    const fetcher = vi.fn<LmFetch>().mockImplementationOnce(() => gate.promise).mockImplementation(async () => completion());
    const pending = run({ fetcher });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending).result.type).toBe('finished');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).not.toHaveProperty('timings_per_token');
    gate.resolve(Response.json(props));
    await flushPromises();
    expect((await run({ fetcher })).result.type).toBe('finished');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toHaveProperty('timings_per_token', true);
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('does not probe model listing even with automatic measurement enabled', async () => {
    const fetcher = vi.fn<LmFetch>(async () => Response.json({ data: [{ id: 'model' }] }));
    const provider = new OpenAIProvider({ endpoint: 'http://localhost/v1', fetcher, llamaCppServerTimings: 'auto' });
    expect(await provider.listModels({ signal: undefined })).toEqual(['model']);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://localhost/v1/models', expect.anything());
  });
});
