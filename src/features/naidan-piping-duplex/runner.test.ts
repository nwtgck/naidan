// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { AttemptError, Deadline, sleep } from '@/features/naidan-piping-duplex/finite';
import type { AttemptKind, FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { retryDelay, runDuplex, validatePacing } from '@/features/naidan-piping-duplex/runner';
import type { RunnerEvent } from '@/features/naidan-piping-duplex/runner';
import { StreamSession } from '@/features/naidan-piping-duplex/session';
import { keyPair, mailbox, opened, offeredCapsule, sessionPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
const pacing = { minimumMs: 2, idleResendIntervalMs: 100, retryBaseMs: 10, retryMaximumMs: 80 };

async function waitForAbort({ signal }: { signal: AbortSignal }): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort); reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function idleEndpoint(): FiniteTransport {
  return { origin: 'https://relay.invalid', send: waitForAbort, receive: waitForAbort, repair: async () => {} };
}

it('retry jitter remains within exponential and capped bounds for every streak', () => {
  for (let failures = 1; failures < 100; failures++) {
    const ceiling = Math.min(10 * 2 ** Math.min(failures - 1, 31), 80);
    for (const randomUnit of [0, 0.125, 0.5, 0.999999]) {
      const delay = retryDelay({ failures, baseMs: 10, maximumMs: 80, randomUnit });
      expect(delay).toBeGreaterThanOrEqual(Math.ceil(ceiling / 2)); expect(delay).toBeLessThanOrEqual(ceiling);
      expect(Number.isInteger(delay)).toBe(true);
    }
  }
  expect(retryDelay({ failures: Number.MAX_SAFE_INTEGER, baseMs: 2, maximumMs: 2147483647, randomUnit: 0.999999 })).toBeLessThanOrEqual(2147483647);
});

it.each([
  { failures: 0 }, { failures: 1.5 }, { failures: Number.NaN }, { failures: Number.MAX_SAFE_INTEGER + 1 },
  { baseMs: 1 }, { maximumMs: 9 }, { maximumMs: 2147483648 }, { randomUnit: -0.1 }, { randomUnit: 1 }, { randomUnit: Infinity },
])('invalid backoff parameters fail closed: %j', invalid => {
  expect(() => retryDelay({ failures: 1, baseMs: 10, maximumMs: 80, randomUnit: 0, ...invalid })).toThrow('parameters');
});

it.each([
  { minimumMs: 0 }, { minimumMs: 1.5 }, { idleResendIntervalMs: 1 }, { retryBaseMs: 1 },
  { retryMaximumMs: 9 }, { idleResendIntervalMs: Infinity }, { retryMaximumMs: 2147483648 },
])('invalid pacing is rejected before taking transport ownership: %j', async invalid => {
  const { a } = await sessionPair(), endpoint = idleEndpoint(), send = vi.spyOn(endpoint, 'send');
  expect(() => validatePacing({ pacing: { ...pacing, ...invalid } })).toThrow('parameters');
  await expect(runDuplex({ session: a, endpoint, pacing: { ...pacing, ...invalid }, signal: new AbortController().signal, onEvent: () => {} })).rejects.toThrow('parameters');
  expect(send).not.toHaveBeenCalled(); const release = a.claimTransport(); release();
});

it('sleep and deadlines remove timers and abort listeners on every completion path', async () => {
  vi.useFakeTimers();
  const stop = new AbortController(), remove = vi.spyOn(stop.signal, 'removeEventListener');
  const expired = new Deadline({ parent: stop.signal, milliseconds: 20 });
  await vi.advanceTimersByTimeAsync(19); expect(expired.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(expired.signal.aborted).toBe(true); expired.dispose();
  const finished = sleep({ milliseconds: 10, signal: stop.signal });
  await vi.advanceTimersByTimeAsync(10); await finished;
  const cancelled = sleep({ milliseconds: 1000, signal: stop.signal });
  const rejected = expect(cancelled).rejects.toThrow('Stop sleeping'); stop.abort(new Error('Stop sleeping')); await rejected;
  expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledTimes(3);
  const preaborted = new Deadline({ parent: stop.signal, milliseconds: 500 });
  expect(preaborted.signal.reason).toBe(stop.signal.reason); preaborted.dispose();
  await expect(sleep({ milliseconds: 1, signal: stop.signal })).rejects.toBe(stop.signal.reason);
  expect(vi.getTimerCount()).toBe(0);
});

it('unchanged idle state waits for a heartbeat instead of flooding minimum-interval POSTs', async () => {
  const { a } = await sessionPair(), stop = new AbortController(), endpoint = idleEndpoint();
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  let sends = 0;
  endpoint.send = async () => {
    sends++; if (sends === 1) first.resolve(); else second.resolve();
  };
  vi.useFakeTimers();
  const running = runDuplex({ session: a, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
  try {
    await first.promise; await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101); expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await second.promise; expect(sends).toBe(2);
  } finally {
    stop.abort(); await running;
  }
  expect(vi.getTimerCount()).toBe(0); expect(a.stopped).toBe(false);
});

it('a revision made during an outstanding POST bypasses the long heartbeat', async () => {
  const { a } = await sessionPair(), stop = new AbortController(), endpoint = idleEndpoint();
  const first = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  let sends = 0;
  endpoint.send = async () => {
    sends++; if (sends === 1) {
      first.resolve(); await release.promise;
    } else second.resolve();
  };
  vi.useFakeTimers();
  const running = runDuplex({ session: a, endpoint, signal: stop.signal, pacing: { ...pacing, idleResendIntervalMs: 10000 }, onEvent: () => {} });
  try {
    await first.promise; await a.drain({ signal: undefined }); release.resolve();
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(2); await second.promise;
    expect(sends).toBe(2);
  } finally {
    stop.abort(); release.resolve(); await running;
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['waiting-sender', 'waiting-receiver', 'established', 'transient'] as AttemptKind[])(
  'sender retries %s and only repairs the documented occupied-sender cases', async kind => {
    const { a } = await sessionPair(), stop = new AbortController(), endpoint = idleEndpoint();
    let sends = 0; const events: RunnerEvent['kind'][] = [], repair = vi.spyOn(endpoint, 'repair');
    endpoint.send = async () => {
      sends++; if (sends === 1) throw new AttemptError({ kind });
    };
    const running = runDuplex({
      session: a,
      endpoint,
      signal: stop.signal,
      pacing,
      onEvent: ({ event }) => {
        events.push(event.kind); if (event.kind === 'sent') stop.abort();
      },
    });
    try {
      await running;
    } finally {
      stop.abort();
    }
    expect(sends).toBe(2); expect(events).toContain('retry');
    expect(repair).toHaveBeenCalledTimes(kind === 'waiting-sender' ? 1 : 0);
    expect(a.stopped).toBe(false);
  },
);

it('invalid ciphertext backs off before a valid authenticated snapshot without applying the invalid data', async () => {
  const { a, b } = await sessionPair(), capsule = await offeredCapsule({ session: b }), endpoint = idleEndpoint(), stop = new AbortController();
  let calls = 0; const events: RunnerEvent['kind'][] = [];
  endpoint.receive = async () => {
    calls++; return calls === 1 ? new Uint8Array([0]) : capsule;
  };
  const running = runDuplex({
    session: a,
    endpoint,
    pacing,
    signal: stop.signal,
    onEvent: ({ event }) => {
      events.push(event.kind); if (event.kind === 'received') stop.abort();
    },
  });
  try {
    await running;
  } finally {
    stop.abort();
  }
  expect(calls).toBe(2); expect(events).toEqual(['unauthenticated', 'received']); expect(a.stopped).toBe(false);
});

it('fatal receive failure aborts the pending sender and is not converted into a retry', async () => {
  const { a } = await sessionPair(), endpoint = idleEndpoint(), stop = new AbortController();
  const entered = Promise.withResolvers<void>(), failure = new AttemptError({ kind: 'fatal' }); let cleaned = false;
  endpoint.send = async ({ signal }) => {
    entered.resolve(); try {
      await waitForAbort({ signal });
    } finally {
      cleaned = true;
    }
  };
  endpoint.receive = async () => {
    await entered.promise; throw failure;
  };
  const onEvent = vi.fn();
  await expect(runDuplex({ session: a, endpoint, signal: stop.signal, pacing, onEvent })).rejects.toBe(failure);
  expect(cleaned).toBe(true); expect(a.stopped).toBe(true); expect(onEvent).not.toHaveBeenCalled();
});

it('observer exceptions stop the runner, abort outstanding requests, and reach its caller', async () => {
  const { a } = await sessionPair(), endpoint = idleEndpoint(), stop = new AbortController();
  endpoint.send = async () => {};
  const failure = new Error('Observer failed');
  await expect(runDuplex({
    session: a,
    endpoint,
    signal: stop.signal,
    pacing,
    onEvent: () => {
      throw failure;
    },
  })).rejects.toBe(failure);
  expect(a.stopped).toBe(true);
});

it('transport ownership remains reserved until cancelled HTTP jobs finish their cleanup', async () => {
  const { a } = await sessionPair(), endpoint = idleEndpoint(), stop = new AbortController();
  const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  endpoint.receive = async ({ signal }) => {
    entered.resolve();
    try {
      return await waitForAbort({ signal });
    } finally {
      cancelled.resolve(); await release.promise;
    }
  };
  const running = runDuplex({ session: a, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
  await entered.promise; stop.abort(); await cancelled.promise;
  try {
    expect(() => a.claimTransport()).toThrow(/owned/);
  } finally {
    release.resolve(); await running;
  }
  const staleRelease = a.claimTransport(); staleRelease();
  const activeRelease = a.claimTransport(); staleRelease();
  expect(() => a.claimTransport()).toThrow(/owned/); activeRelease();
});

it('pre-cancelled transport performs no HTTP call and releases its owner', async () => {
  const { a } = await sessionPair(), endpoint = idleEndpoint(), stop = new AbortController(); stop.abort();
  const send = vi.spyOn(endpoint, 'send'), receive = vi.spyOn(endpoint, 'receive');
  await runDuplex({ session: a, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
  expect(send).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
  const release = a.claimTransport(); release();
});

it('authenticated receipt releases a stalled POST only after that POST finishes its owned cleanup', async () => {
  const { a, b } = await sessionPair(), stop = new AbortController(), endpoint = idleEndpoint(), toA = mailbox();
  const delivered = Promise.withResolvers<void>(), cancelling = Promise.withResolvers<void>();
  const join = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  let sends = 0;
  endpoint.send = async ({ bytes, signal }) => {
    sends++;
    if (sends === 1) {
      await b.acceptCapsule({ capsule: bytes }); delivered.resolve();
      try {
        await waitForAbort({ signal });
      } finally {
        cancelling.resolve(); await join.promise;
      }
    } else {
      second.resolve(); stop.abort();
    }
  };
  endpoint.receive = toA.receive;
  const running = runDuplex({ session: a, endpoint, signal: stop.signal, pacing, onEvent: () => {} });
  try {
    await delivered.promise;
    await toA.send({ bytes: await offeredCapsule({ session: b }) });
    await cancelling.promise;
    expect(sends).toBe(1);
    expect(() => a.claimTransport()).toThrow('owned');
    join.resolve();
    await second.promise; await running;
    expect(sends).toBe(2); expect(a.stopped).toBe(false);
  } finally {
    stop.abort(); join.resolve(); await running;
  }
});

it('repeated receipt requests cannot interrupt an unreceived DATA POST or starve its stream', async () => {
  const { a, b } = await sessionPair(), { aStream } = await opened({ a, b });
  const writer = aStream.writable.getWriter(), writing = writer.write(new Uint8Array(32000));
  const rejected = expect(writing).rejects.toThrow('Stream reset');
  await vi.waitFor(() => expect(a.debug()).toMatchObject({ streams: [expect.objectContaining({ txEnd: '32000' })] }));
  const endpoint = idleEndpoint(), stop = new AbortController(), toA = mailbox();
  const entered = Promise.withResolvers<AbortSignal>(), requestsReceived = Promise.withResolvers<void>();
  let sends = 0, requests = 0;
  endpoint.send = async ({ bytes, signal }) => {
    sends++; expect(bytes.length).toBeGreaterThan(16384); entered.resolve(signal);
    await waitForAbort({ signal });
  };
  endpoint.receive = toA.receive;
  const running = runDuplex({
    session: a,
    endpoint,
    signal: stop.signal,
    pacing,
    onEvent: ({ event }) => {
      if (event.kind === 'received' && ++requests === 3) requestsReceived.resolve();
    },
  });
  try {
    const sending = await entered.promise;
    for (let attempt = 0; attempt < 3; attempt++) await toA.send({ bytes: await offeredCapsule({ session: b }) });
    await requestsReceived.promise;
    expect(sends).toBe(1); expect(sending.aborted).toBe(false);
  } finally {
    stop.abort(); await running;
    aStream.abort({ reason: 'Test cleanup' }); await rejected; writer.releaseLock();
  }
});

it.each([false, true])('starts new idle probes, preserves the response request across a dropped candidate (%s), and stops echoing', async dropInitialProbe => {
  const keys = await keyPair();
  const a = await StreamSession.create({ keys: keys.a }), b = await StreamSession.create({ keys: keys.b });
  const stop = new AbortController(), toA = mailbox(), toB = mailbox();
  let aPosts = 0, bPosts = 0, activeA = 0, activeB = 0;
  const endpoint = ({ outgoing, incoming, side }: { outgoing: ReturnType<typeof mailbox>; incoming: ReturnType<typeof mailbox>; side: 'a' | 'b' }): FiniteTransport => ({
    origin: 'https://piping.example',
    send: async ({ bytes, signal }) => {
      if (side === 'a') {
        aPosts++; activeA++; expect(activeA).toBe(1);
      } else {
        bPosts++; activeB++; expect(activeB).toBe(1);
      }
      const ordinal = side === 'a' ? aPosts : bPosts;
      try {
        if (!(dropInitialProbe && side === 'a' && ordinal === 3)) await outgoing.send({ bytes });
        if (ordinal > 1) await waitForAbort({ signal });
      } finally {
        if (side === 'a') activeA--; else activeB--;
      }
    },
    receive: incoming.receive,
    repair: async () => {
      throw new Error('Unexpected repair');
    },
  });
  const pacing = { minimumMs: 1, idleResendIntervalMs: 20000, retryBaseMs: 2, retryMaximumMs: 2 };
  const left = runDuplex({ session: a, endpoint: endpoint({ outgoing: toB, incoming: toA, side: 'a' }), signal: stop.signal, pacing, onEvent: () => {} });
  const right = runDuplex({ session: b, endpoint: endpoint({ outgoing: toA, incoming: toB, side: 'b' }), signal: stop.signal, pacing, onEvent: () => {} });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect({ aPosts, bPosts }).toEqual({ aPosts: 2, bPosts: 2 });
    const startedA = vi.fn(), startedB = vi.fn();
    const confirmedA = a.confirmResponse({ signal: stop.signal, onRequestStarted: startedA });
    const confirmedB = b.confirmResponse({ signal: stop.signal, onRequestStarted: startedB });
    await Promise.all([confirmedA, confirmedB]);
    expect(startedA).toHaveBeenCalledOnce(); expect(startedB).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 25));
    const settled = { aPosts, bPosts };
    await new Promise(resolve => setTimeout(resolve, 100));
    expect({ aPosts, bPosts }).toEqual(settled);
    expect(aPosts + bPosts).toBeLessThan(15);
    expect(a.stopped).toBe(false); expect(b.stopped).toBe(false);
  } finally {
    stop.abort(); await Promise.all([left, right]); a.abort({ reason: 'Done' }); b.abort({ reason: 'Done' });
  }
});
