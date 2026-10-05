// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { FiniteEndpoint, readBounded } from '@/features/naidan-piping-duplex/finite';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
beforeEach(() => vi.useFakeTimers());

it.each([
  { baseUrl: 'https://RELAY.invalid:443/', policy: 'https-only', origin: 'https://relay.invalid' },
  { baseUrl: 'https://relay.invalid:8443/', policy: 'https-only', origin: 'https://relay.invalid:8443' },
  { baseUrl: 'http://127.0.0.1:1234/', policy: 'allow-loopback-http', origin: 'http://127.0.0.1:1234' },
  { baseUrl: 'http://[::1]:1234/', policy: 'allow-loopback-http', origin: 'http://[::1]:1234' },
  { baseUrl: 'http://localhost:1234/', policy: 'allow-loopback-http', origin: 'http://localhost:1234' },
] as const)('accepts and canonicalizes an explicitly allowed relay origin: $baseUrl', ({ baseUrl, policy, origin }) => {
  const endpoint = new FiniteEndpoint({ baseUrl, policy, timeoutMs: 1, repairTimeoutMs: 2147483647 });
  expect(endpoint.origin).toBe(origin);
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { baseUrl: 'http://127.0.0.1', policy: 'https-only' },
  { baseUrl: 'http://relay.invalid', policy: 'allow-loopback-http' },
  { baseUrl: 'http://localhost.relay.invalid', policy: 'allow-loopback-http' },
  { baseUrl: 'http://127.0.0.1.relay.invalid', policy: 'allow-loopback-http' },
  { baseUrl: 'http://[::ffff:127.0.0.1]', policy: 'allow-loopback-http' },
  { baseUrl: 'https://localhost@relay.invalid', policy: 'allow-loopback-http' },
  { baseUrl: 'https://relay.invalid/path', policy: 'https-only' },
  { baseUrl: 'https://relay.invalid/?token=secret', policy: 'https-only' },
  { baseUrl: 'https://relay.invalid/#secret', policy: 'https-only' },
  { baseUrl: 'wss://relay.invalid', policy: 'https-only' },
] as const)('does not widen relay policy for misleading or non-origin URLs: $baseUrl', ({ baseUrl, policy }) => {
  expect(() => new FiniteEndpoint({ baseUrl, policy, timeoutMs: 100, repairTimeoutMs: 20 })).toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, -1, 0.5, NaN, Infinity, 2147483648])('rejects invalid request and repair deadlines before I/O: %s', invalid => {
  for (const durations of [{ timeoutMs: invalid, repairTimeoutMs: 20 }, { timeoutMs: 100, repairTimeoutMs: invalid }]) {
    expect(() => new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', ...durations })).toThrow('deadlines');
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([-1, 0.5, NaN, Infinity, 65537])('rejects invalid allocation bound %s without taking ownership of the body', async maxBytes => {
  const response = new Response(new Uint8Array([5]));
  await expect(readBounded({ response, maxBytes })).rejects.toThrow('bound');
  expect(response.bodyUsed).toBe(false);
  expect(response.body?.locked).toBe(false);
  await expect(readBounded({ response, maxBytes: 1 })).resolves.toEqual(new Uint8Array([5]));
});

it('permits an absent or empty body at zero capacity but never accepts one nonempty byte', async () => {
  await expect(readBounded({ response: new Response(), maxBytes: 0 })).resolves.toEqual(new Uint8Array());
  const empty = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.close();
  } }));
  await expect(readBounded({ response: empty, maxBytes: 0 })).resolves.toEqual(new Uint8Array());
  const nonempty = new Response(new Uint8Array([1]));
  await expect(readBounded({ response: nonempty, maxBytes: 0 })).rejects.toMatchObject({ kind: 'transient' });
  expect(nonempty.body?.locked).toBe(false);
});

it('measures actual bytes rather than trusting a smaller advertised content length', async () => {
  const response = new Response(new Uint8Array([1, 2]), { headers: { 'Content-Length': '1' } });
  await expect(readBounded({ response, maxBytes: 1 })).rejects.toMatchObject({ kind: 'transient' });
  expect(response.body?.locked).toBe(false);
});

it('does not let failed error-body cancellation change the fatal status or retain POST ownership', async () => {
  const cancel = vi.fn().mockRejectedValue(new Error('Body cancellation failed'));
  const rejected = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
  vi.mocked(fetch).mockResolvedValueOnce(rejected).mockResolvedValueOnce(new Response());
  const endpoint = new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
  const request = { route: 'slot', bytes: new Uint8Array([1]), signal: new AbortController().signal };
  await expect(endpoint.send(request)).rejects.toMatchObject({ kind: 'fatal' });
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(endpoint.send(request)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps POST ownership until a successful response body has drained, not merely until headers arrive', async () => {
  const reading = Promise.withResolvers<void>();
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
    pull() {
      reading.resolve();
    },
  }));
  vi.mocked(fetch).mockResolvedValueOnce(response).mockResolvedValue(new Response());
  const endpoint = new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
  const request = { route: 'slot', bytes: new Uint8Array([1]), signal: new AbortController().signal };
  const sending = endpoint.send(request);
  try {
    await reading.promise;
    await expect(endpoint.send(request)).rejects.toThrow('Concurrent');
    await expect(endpoint.repair({ route: request.route, signal: request.signal })).rejects.toThrow('Concurrent');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    body?.close(); await sending;
  }
  await expect(endpoint.send(request)).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('releases send ownership when rejecting shared input and does not transmit any invalid prefix', async () => {
  const endpoint = new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
  const signal = new AbortController().signal;
  await expect(endpoint.send({ route: 'slot', bytes: new Uint8Array(new SharedArrayBuffer(1)), signal })).rejects.toThrow('non-shared');
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValue(new Response());
  await expect(endpoint.send({ route: 'slot', bytes: new Uint8Array([7]), signal })).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
