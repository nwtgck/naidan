import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { LmFetch } from './fetch';
import { resolveLlamaCppServerTimings, TEST_ONLY } from './llama-cpp-server-timings';
import { useMetricsFakeTimersForTest } from './generation-metrics-stream.test-support';

const endpoint = 'https://server.invalid/llama/v1';
const supportedProps = { default_generation_settings: { params: { timings_per_token: false } } };

function request({ headers, signal = new AbortController().signal, url = endpoint }: { headers?: [string, string][], signal?: AbortSignal, url?: string } = {}) {
  return { endpoint: url, headers, signal };
}

describe('llama.cpp props URL derivation', () => {
  it.each([
    ['http://localhost:8080/v1', 'http://localhost:8080/props'],
    ['http://localhost:8080/v1/', 'http://localhost:8080/props'],
    ['http://localhost:8080/v1///', 'http://localhost:8080/props'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/props'],
    ['https://host/llama/v1', 'https://host/llama/props'],
    ['https://host/v1/proxy/v1/', 'https://host/v1/proxy/props'],
    ['https://host/a%20b/v1', 'https://host/a%20b/props'],
  ])('derives only the terminal version path: %s', (url, expected) => {
    expect(TEST_ONLY.derivePropsUrl({ endpoint: url })).toBe(expected);
  });

  it.each(['', '/v1', 'localhost/v1', 'https://host', 'https://host/v10', 'https://host/V1', 'https://host/v1/models', 'https://host/v1?key=secret', 'https://host/v1?', 'https://host/v1#', 'https://host/v1#part', 'https://name:secret@host/v1', 'file:///v1', 'ftp://host/v1'])('does not guess or broaden the scope of %s', url => {
    expect(TEST_ONLY.derivePropsUrl({ endpoint: url })).toBeUndefined();
  });
});

describe('bounded optional capability detection', () => {
  it.each([true, false])('accepts the boolean capability, including default=%s', async defaultValue => {
    const fetcher = vi.fn<LmFetch>(async () => Response.json({ default_generation_settings: { params: { timings_per_token: defaultValue } } }));
    const detector = TEST_ONLY.createDetector({ fetcher });
    expect(await detector.resolve(request())).toBe(true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://server.invalid/llama/props', expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' }));
  });

  it.each([null, {}, { build_info: 'b12345' }, { timings_per_token: true }, { default_generation_settings: { params: { timings_per_token: 'false' } } }, { default_generation_settings: { params: {} } }])('requires the documented feature shape, not a brand guess: %j', async value => {
    const fetcher = vi.fn<LmFetch>(async () => Response.json(value));
    expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(false);
  });

  it.each(['enabled', 'disabled'] as const)('does not probe in manual mode %s', async mode => {
    const fetcher = vi.fn<LmFetch>();
    expect(await resolveLlamaCppServerTimings({ ...request(), mode, fetcher })).toBe(mode === 'enabled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips invalid URLs and pre-aborted callers', async () => {
    const fetcher = vi.fn<LmFetch>();
    const detector = TEST_ONLY.createDetector({ fetcher });
    expect(await detector.resolve(request({ url: 'https://host/no-version' }))).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(await detector.resolve(request({ signal: controller.signal }))).toBe(false);
    expect(await resolveLlamaCppServerTimings({ ...request({ signal: controller.signal }), mode: 'enabled', fetcher })).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('snapshots custom authentication and separates changed credentials and routes', async () => {
    const fetcher = vi.fn<LmFetch>(async () => Response.json(supportedProps));
    const detector = TEST_ONLY.createDetector({ fetcher });
    const headers: [string, string][] = [['Authorization', 'Bearer first'], ['X-Route', 'a']];
    const pending = detector.resolve(request({ headers }));
    headers[0]![1] = 'Bearer second';
    expect(await pending).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual([['Authorization', 'Bearer first'], ['X-Route', 'a']]);
    expect(await detector.resolve(request({ headers }))).toBe(true);
    expect(await detector.resolve(request({ headers }))).toBe(true);
    expect(await detector.resolve(request({ headers, url: 'https://server.invalid/other/v1' }))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('separates evidence for different injected fetch transports', async () => {
    const real = vi.fn<LmFetch>(async () => Response.json(supportedProps));
    const other = vi.fn<LmFetch>(async () => Response.json({}));
    expect(await resolveLlamaCppServerTimings({ ...request(), mode: 'auto', fetcher: real })).toBe(true);
    expect(await resolveLlamaCppServerTimings({ ...request(), mode: 'auto', fetcher: other })).toBe(false);
    expect(other).toHaveBeenCalledOnce();
  });

  it('expires successful and unknown results independently without persisting either', async () => {
    let now = 0;
    const fetcher = vi.fn<LmFetch>(async () => Response.json(supportedProps));
    const detector = TEST_ONLY.createDetector({ fetcher, now: () => now });
    expect(await detector.resolve(request())).toBe(true);
    now = TEST_ONLY.SUPPORTED_TTL_MS - 1;
    expect(await detector.resolve(request())).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    now++;
    fetcher.mockImplementation(async () => Response.json({}));
    expect(await detector.resolve(request())).toBe(false);
    now += TEST_ONLY.UNKNOWN_TTL_MS - 1;
    expect(await detector.resolve(request())).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now++;
    fetcher.mockImplementation(async () => Response.json(supportedProps));
    expect(await detector.resolve(request())).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([401, 404, 500])('contains HTTP %s without logging credentials or failing generation', async status => {
    using log = vi.spyOn(console, 'error');
    const fetcher = vi.fn<LmFetch>(async () => new Response('secret response', { status }));
    expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('contains invalid JSON, CORS failure and synchronous fetch failure', async () => {
    const fetcher = vi.fn<LmFetch>().mockResolvedValueOnce(new Response('<html>not props</html>')).mockRejectedValueOnce(new Error('CORS')).mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    for (let i = 0; i < 3; i++) {
      expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(false);
    }
  });

  it('bounds the body by bytes and cancels the reader when it is too large', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TEST_ONLY.MAX_PROPS_BYTES + 1));
      },
      cancel,
    });
    const fetcher = vi.fn<LmFetch>(async () => new Response(body));
    expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('shares a pending probe while one aborted generation only releases its own wait', async () => {
    using timers = useMetricsFakeTimersForTest();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<LmFetch>(() => response.promise);
    const detector = TEST_ONLY.createDetector({ fetcher });
    const controller = new AbortController();
    const first = detector.resolve(request({ signal: controller.signal }));
    const second = detector.resolve(request());
    controller.abort();
    expect(await first).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    response.resolve(Response.json(supportedProps));
    expect(await second).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('releases the generation after its budget and uses late positive evidence next time', async () => {
    using timers = useMetricsFakeTimersForTest();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<LmFetch>(() => response.promise);
    const detector = TEST_ONLY.createDetector({ fetcher });
    const first = detector.resolve(request());
    await vi.advanceTimersByTimeAsync(TEST_ONLY.WAIT_MS);
    expect(await first).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    response.resolve(Response.json(supportedProps));
    await flushPromises();
    expect(await detector.resolve(request())).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('times out an abort-ignoring fetch and discards its late body', async () => {
    using timers = useMetricsFakeTimersForTest();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<LmFetch>(() => response.promise);
    const detector = TEST_ONLY.createDetector({ fetcher });
    const pending = detector.resolve(request());
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_MS);
    expect(await pending).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    response.resolve(new Response(new ReadableStream({ cancel })));
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await detector.resolve(request())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('cancels a stalled body as well as the fetch signal', async () => {
    using timers = useMetricsFakeTimersForTest();
    const cancel = vi.fn();
    const fetcher = vi.fn<LmFetch>(async () => new Response(new ReadableStream({ cancel })));
    const pending = TEST_ONLY.createDetector({ fetcher }).resolve(request());
    await flushPromises();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_MS);
    expect(await pending).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('bounds pending cache entries and never reinserts an evicted late result', async () => {
    using timers = useMetricsFakeTimersForTest();
    const firstResponse = Promise.withResolvers<Response>();
    const fetcher = vi.fn<LmFetch>(() => new Promise(() => {}));
    fetcher.mockImplementationOnce(() => firstResponse.promise);
    const detector = TEST_ONLY.createDetector({ fetcher });
    const pending = Array.from({ length: TEST_ONLY.MAX_ENTRIES + 1 }, (_, index) => detector.resolve(request({ url: `https://host/${index}/v1` })));
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await pending[0]).toBe(false);
    firstResponse.resolve(Response.json(supportedProps));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_MS);
    for (const result of pending) {
      expect(await result).toBe(false);
    }
    fetcher.mockImplementation(async () => Response.json({}));
    expect(await detector.resolve(request({ url: 'https://host/0/v1' }))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(TEST_ONLY.MAX_ENTRIES + 2);
    expect(vi.getTimerCount()).toBe(0);
    void timers;
  });

  it('rejects a redirected response even from a fetch adapter that followed it', async () => {
    const response = Response.json(supportedProps);
    using redirected = vi.spyOn(response, 'redirected', 'get').mockReturnValue(true);
    const fetcher = vi.fn<LmFetch>(async () => response);
    expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(false);
    void redirected;
  });

  it('reads fragmented UTF-8 JSON without requiring a content-type header', async () => {
    const data = new TextEncoder().encode(JSON.stringify({ ...supportedProps, chat_template: '例🙂' }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of data) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    });
    const fetcher = vi.fn<LmFetch>(async () => new Response(body));
    expect(await TEST_ONLY.createDetector({ fetcher }).resolve(request())).toBe(true);
  });
});
