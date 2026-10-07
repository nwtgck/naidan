// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttemptError, FiniteEndpoint, needsSenderRepair, readBounded } from '@/features/naidan-piping-duplex/finite';

// All requests terminate at this mock; these tests never open a socket or launch a server.
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch in unit test'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function endpoint() {
  return new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
}
function responseStream({ chunks, status }: { chunks: Uint8Array[]; status: number }) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel,
  }), { status });
  return { response, cancel };
}

for (const kind of ['waiting-sender', 'waiting-receiver', 'established', 'transient', 'fatal'] as const) {
  it(`only waiting-sender permits self-GET repair: ${kind}`, () => {
    expect(needsSenderRepair({ kind })).toBe(kind === 'waiting-sender');
  });
}

it('POST snapshots a finite body and uses constrained fetch options', async () => {
  const instance = endpoint(), stop = new AbortController();
  vi.mocked(fetch).mockResolvedValue(new Response('sent', { status: 200 }));
  const backing = new Uint8Array([9, 1, 2, 9]);
  const task = instance.send({ route: 'route_1', bytes: backing.subarray(1, 3), signal: stop.signal });
  backing.fill(0);
  await task;
  const call = vi.mocked(fetch).mock.calls[0];
  expect(call?.[0]).toBe('https://relay.invalid/route_1');
  expect(call?.[1]).toMatchObject({
    method: 'POST',
    body: new Uint8Array([1, 2]),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    mode: 'cors',
  });
  expect(call?.[1]).not.toHaveProperty('duplex');
  expect(call?.[1]).not.toHaveProperty('headers');
  expect(call?.[1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('GET joins HTTP body fragments without treating them as application records', async () => {
  const stop = new AbortController();
  const { response } = responseStream({ chunks: [new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])], status: 200 });
  vi.mocked(fetch).mockResolvedValue(response);
  expect(await endpoint().receive({ route: 'receive', signal: stop.signal })).toEqual(new Uint8Array([1, 2, 3]));
  expect(vi.mocked(fetch).mock.calls[0]?.[1]).not.toHaveProperty('body');
  expect(response.body?.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('the exact read limit is allowed and the public buffer is independently owned', async () => {
  const source = new Uint8Array(65536).fill(7);
  const { response } = responseStream({ chunks: [source], status: 200 });
  const received = await readBounded({ response, maxBytes: 65536 });
  source.fill(9);
  expect(received.length).toBe(65536);
  expect(received.every(byte => byte === 7)).toBe(true);
});

it('an oversized body is cancelled, not returned as a partial success', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65537));
    },
    cancel,
  }));
  vi.mocked(fetch).mockResolvedValue(response);
  await expect(endpoint().receive({ route: 'receive', signal: new AbortController().signal }))
    .rejects.toMatchObject({ kind: 'transient' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

for (const [status, kind] of [[200, 'transient'], [403, 'fatal'], [503, 'transient']] as const) {
  for (const cleanupOutcome of ['resolved', 'rejected'] as const) {
    it(`HTTP ${status} retains POST ownership until ${cleanupOutcome} response cancellation finishes`, async () => {
      const cleanup = Promise.withResolvers<void>(), cancel = vi.fn(() => cleanup.promise);
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (status === 200) controller.enqueue(new Uint8Array(8193));
        },
        cancel,
      }), { status });
      vi.mocked(fetch).mockResolvedValueOnce(response);
      const instance = endpoint(), signal = new AbortController().signal;
      let settled = false;
      const first = instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal }).then(() => {
        settled = true;
      }, (error: unknown) => {
        settled = true; return error;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(cancel).toHaveBeenCalledOnce(); expect(settled).toBe(false);
        await expect(instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal })).rejects.toThrow('Concurrent');
        await expect(instance.repair({ route: 'slot', signal })).rejects.toThrow('Concurrent');
        expect(fetch).toHaveBeenCalledOnce();
        if (cleanupOutcome === 'resolved') cleanup.resolve(); else cleanup.reject(new Error('Cleanup failed'));
        expect(await first).toMatchObject({ kind });
        expect(response.body?.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        vi.mocked(fetch).mockResolvedValueOnce(new Response('sent'));
        await instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        cleanup.resolve(); await first;
      }
    });
  }
}

it('a broken response body cannot publish its already-read prefix', async () => {
  let pulls = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(new Error('Disconnected during body'));
    },
  }));
  vi.mocked(fetch).mockResolvedValue(response);
  await expect(endpoint().receive({ route: 'receive', signal: new AbortController().signal }))
    .rejects.toMatchObject({ kind: 'transient' });
  expect(response.body?.locked).toBe(false);
});

for (const [diagnostic, kind] of [
  ["[ERROR] Another sender has been connected on '/slot'.", 'waiting-sender'],
  ["[ERROR] Connection on '/slot' has been established already.", 'established'],
  ['[ERROR] The number of receivers has reached limits.', 'waiting-receiver'],
  ["[ERROR] Another sender has been connected on '/other'.", 'transient'],
  ['Bad Request', 'transient'],
] as const) {
  it(`classifies a bounded 400 without guessing from the status alone: ${diagnostic}`, async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(diagnostic, { status: 400 }));
    await expect(endpoint().send({ route: 'slot', bytes: new Uint8Array([1]), signal: new AbortController().signal }))
      .rejects.toMatchObject({ kind });
    expect(fetch).toHaveBeenCalledTimes(1); // Classification does not perform repair by itself.
    expect(vi.getTimerCount()).toBe(0);
  });
}

for (const [status, kind] of [[401, 'fatal'], [403, 'fatal'], [404, 'fatal'], [408, 'transient'], [429, 'transient'], [503, 'transient']] as const) {
  it(`HTTP ${status} classification does not depend on completing an error page`, async () => {
    const cancel = vi.fn();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel,
    }), { status });
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      // Real fetch errors a still-readable body on abort, including after headers arrive.
      if (!signal) throw new Error('Missing request signal');
      signal.addEventListener('abort', () => bodyController.error(signal.reason), { once: true });
      return response;
    });
    const stop = new AbortController();
    let outcome: unknown;
    const task = endpoint().receive({ route: 'receive', signal: stop.signal }).catch(error => {
      outcome = error;
    });
    try {
      // Headers alone determine these statuses. No deadline advance should be necessary.
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeInstanceOf(AttemptError);
      expect(outcome).toMatchObject({ kind });
      await task;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop.abort();
      await task;
    }
  });
}

it('pre-cancelled operations do not enter fetch or allocate a deadline', async () => {
  const instance = endpoint(), stop = new AbortController(), reason = new Error('Already cancelled');
  stop.abort(reason);
  await expect(instance.receive({ route: 'slot', signal: stop.signal })).rejects.toBe(reason);
  await expect(instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal: stop.signal })).rejects.toBe(reason);
  await expect(instance.repair({ route: 'slot', signal: stop.signal })).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('invalid repair routes are caller errors, not successful repairs', async () => {
  await expect(endpoint().repair({ route: '../other', signal: new AbortController().signal })).rejects.toThrow('Invalid route');
  expect(fetch).not.toHaveBeenCalled();
});

it('request deadline and repair deadline bound absent counterparts and release ownership', async () => {
  const signals: AbortSignal[] = [];
  vi.mocked(fetch).mockImplementation((_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Missing request signal');
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const instance = endpoint(), signal = new AbortController().signal;
  const sending = expect(instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal })).rejects.toMatchObject({ kind: 'transient' });
  await expect(instance.repair({ route: 'slot', signal })).rejects.toThrow('Concurrent');
  await vi.advanceTimersByTimeAsync(100); await sending;
  const repairing = instance.repair({ route: 'slot', signal });
  await expect(instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal })).rejects.toThrow('Concurrent');
  await vi.advanceTimersByTimeAsync(20); await repairing;
  vi.mocked(fetch).mockResolvedValue(new Response('sent'));
  await instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal });
  expect(signals.every(item => item.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('a deadline covers stalled response-body reading after headers arrive', async () => {
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Missing request signal');
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
  });
  const task = expect(endpoint().receive({ route: 'slot', signal: new AbortController().signal }))
    .rejects.toMatchObject({ kind: 'transient' });
  await vi.advanceTimersByTimeAsync(100); await task;
  expect(vi.getTimerCount()).toBe(0);
});

it('parent cancellation is preserved and releases POST ownership', async () => {
  vi.mocked(fetch).mockImplementation((_input, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Missing request signal');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const instance = endpoint(), stop = new AbortController(), reason = new Error('Application stopped');
  const task = expect(instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal: stop.signal })).rejects.toBe(reason);
  stop.abort(reason); await task;
  vi.mocked(fetch).mockResolvedValue(new Response('sent'));
  await instance.send({ route: 'slot', bytes: new Uint8Array([1]), signal: new AbortController().signal });
  expect(vi.getTimerCount()).toBe(0);
});

it('self-GET drains bytes but never reports them as a peer receive or starts its own POST', async () => {
  const instance = endpoint(), signal = new AbortController().signal;
  const { response } = responseStream({ chunks: [new Uint8Array([99]), new Uint8Array([98])], status: 200 });
  vi.mocked(fetch).mockResolvedValue(response);
  expect(await instance.repair({ route: 'slot', signal })).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls.map(call => call[1]?.method)).toEqual(['GET']);
  expect(response.bodyUsed).toBe(true);
});

it('invalid paths and oversized request bodies never reach fetch', async () => {
  const instance = endpoint(), signal = new AbortController().signal;
  for (const route of ['../a', 'a?secret=1', 'a/b', '', 'a'.repeat(97)]) {
    await expect(instance.send({ route, bytes: new Uint8Array([1]), signal })).rejects.toThrow('Invalid route');
  }
  await expect(instance.send({ route: 'slot', bytes: new Uint8Array(65537), signal })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});


it('a large forbidden response remains fatal instead of becoming a size-limit retry', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(8193), { status: 403 }));
  await expect(endpoint().receive({ route: 'slot', signal: new AbortController().signal }))
    .rejects.toMatchObject({ kind: 'fatal' });
});
