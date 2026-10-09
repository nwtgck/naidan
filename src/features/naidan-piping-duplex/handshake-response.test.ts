// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { EstablishedPipingKeys, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import { HandshakeResponseUnconfirmedError, PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import { Pulse } from '@/features/naidan-piping-duplex/bytes';
import { promiseAllKeyed } from '@/utils/promise';

const stops: AbortController[] = [], jobs: Promise<EstablishedPipingKeys>[] = [], releases: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(0);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in handshake response tests'));
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const release of releases.splice(0)) release();
  for (const result of await Promise.allSettled(jobs.splice(0))) if (result.status === 'fulfilled') result.value.keys.dispose();
  vi.useRealTimers(); vi.restoreAllMocks();
});

async function start({ dropFrom, dropAt, known, verifyA, verifyB, onFailure }: {
  dropFrom: 'a' | 'b' | undefined; dropAt: number; known: boolean;
  verifyA: NaidanPipingPeerVerifier | undefined; verifyB: NaidanPipingPeerVerifier | undefined;
  onFailure: (({ error }: { error: unknown }) => void) | undefined;
}) {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const ab: Uint8Array[] = [], ba: Uint8Array[] = [], pulse = new Pulse();
  const sends = { a: 0, b: 0 }, reads = { a: 0, b: 0 };
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const send = ({ side, queue }: { side: 'a' | 'b'; queue: Uint8Array[] }) => async ({ bytes }: { bytes: Uint8Array }) => {
    sends[side]++; waiting.get(`send/${side}/${sends[side]}`)?.resolve();
    if (!(side === dropFrom && sends[side] === dropAt)) queue.push(bytes.slice());
    pulse.fire();
  };
  const receive = ({ side, queue }: { side: 'a' | 'b'; queue: Uint8Array[] }) => async ({ signal }: { signal: AbortSignal }) => {
    reads[side]++; waiting.get(`${side}/${reads[side]}`)?.resolve();
    for (;;) {
      signal.throwIfAborted(); const revision = pulse.revision, bytes = queue.shift();
      if (bytes !== undefined) return bytes;
      await pulse.wait({ revision, signal });
    }
  };
  const stopA = new AbortController(), stopB = new AbortController(); stops.push(stopA, stopB);
  const a = establishVerifiedNaidanPipingKeys({
    role: 'initiator',
    identity: identities.a,
    expectedPeer: known ? identities.b.publicKey : undefined,
    verifyPeer: verifyA,
    binding: new Uint8Array(32),
    channel: { send: send({ side: 'a', queue: ab }), receive: receive({ side: 'a', queue: ba }) },
    signal: stopA.signal,
    responseTimeoutMs: 1000,
    onResponseFailure: onFailure,
  });
  const b = establishVerifiedNaidanPipingKeys({
    role: 'responder',
    identity: identities.b,
    expectedPeer: known ? identities.a.publicKey : undefined,
    verifyPeer: verifyB,
    binding: new Uint8Array(32),
    channel: { send: send({ side: 'b', queue: ba }), receive: receive({ side: 'b', queue: ab }) },
    signal: stopB.signal,
    responseTimeoutMs: 1000,
    onResponseFailure: onFailure,
  });
  jobs.push(a, b); void a.catch(() => {}); void b.catch(() => {});
  return {
    a,
    b,
    sends,
    stopA,
    stopB,
    whenSending({ side, count }: { side: 'a' | 'b'; count: number }) {
      if (sends[side] >= count) return Promise.resolve();
      const gate = Promise.withResolvers<void>(); waiting.set(`send/${side}/${count}`, gate); return gate.promise;
    },
    whenReading({ side, count }: { side: 'a' | 'b'; count: number }) {
      if (reads[side] >= count) return Promise.resolve();
      const gate = Promise.withResolvers<void>(); waiting.set(`${side}/${count}`, gate); return gate.promise;
    },
  };
}

it.each([
  { side: 'a', dropFrom: 'b', dropAt: 1, read: 1, sent: 1, stage: 'noise-2' },
  { side: 'b', dropFrom: 'a', dropAt: 2, read: 2, sent: 1, stage: 'noise-3' },
  { side: 'a', dropFrom: 'b', dropAt: 2, read: 2, sent: 3, stage: 'status' },
  { side: 'b', dropFrom: 'a', dropAt: 3, read: 3, sent: 2, stage: 'status' },
  { side: 'a', dropFrom: 'b', dropAt: 3, read: 3, sent: 4, stage: 'seed' },
  { side: 'b', dropFrom: 'a', dropAt: 4, read: 4, sent: 3, stage: 'seed' },
  { side: 'a', dropFrom: 'b', dropAt: 4, read: 4, sent: 5, stage: 'confirmation' },
  { side: 'b', dropFrom: 'a', dropAt: 5, read: 5, sent: 4, stage: 'confirmation' },
] as const)('expires only the expected $stage response at peer $side', async ({ side, dropFrom, dropAt, read, sent, stage }) => {
  const pair = await start({ known: true, dropFrom, dropAt, verifyA: undefined, verifyB: undefined, onFailure: undefined });
  // Receive now starts concurrently with local encryption. The response clock
  // begins only after encryption, at channel.send registration, not at receive.
  await promiseAllKeyed({ reading: pair.whenReading({ side, count: read }), sending: pair.whenSending({ side, count: sent }) });
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pair[side]).rejects.toMatchObject({ name: 'HandshakeResponseUnconfirmedError', stage });
});

it('accepted status0 leaves local and remote human approval untimed', async () => {
  const aShown = Promise.withResolvers<void>(), bShown = Promise.withResolvers<void>();
  const aApproval = Promise.withResolvers<boolean>(), bApproval = Promise.withResolvers<boolean>();
  releases.push(() => {
    aApproval.resolve(false); bApproval.resolve(false);
  });
  const pair = await start({
    known: false,
    dropFrom: undefined,
    dropAt: 0,
    onFailure: undefined,
    verifyA: () => {
      aShown.resolve(); return aApproval.promise;
    },
    verifyB: () => {
      bShown.resolve(); return bApproval.promise;
    },
  });
  await Promise.all([aShown.promise, bShown.promise]);
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100_000);
  aApproval.resolve(true); await pair.whenReading({ side: 'a', count: 3 });
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100_000);
  bApproval.resolve(true);
  const keys = await promiseAllKeyed({ a: pair.a, b: pair.b }); expect(keys.a.keys.contextId).toEqual(keys.b.keys.contextId);
});

it('lost status0 times out status delivery while its sender may legitimately wait for a person', async () => {
  const shown = Promise.withResolvers<void>(), approval = Promise.withResolvers<boolean>(); releases.push(() => approval.resolve(false));
  const pair = await start({
    known: false,
    dropFrom: 'b',
    dropAt: 2,
    verifyA: async () => true,
    verifyB: () => {
      shown.resolve(); return approval.promise;
    },
    onFailure: undefined,
  });
  let bSettled = false; void pair.b.then(() => {
    bSettled = true;
  }, () => {
    bSettled = true;
  });
  await shown.promise; await vi.advanceTimersByTimeAsync(1000);
  await expect(pair.a).rejects.toMatchObject({ stage: 'status' }); expect(bSettled).toBe(false);
});

it.each(['verify-completes', 'verify-fails'] as const)('timeout retains and joins already-running MAC crypto: %s', async outcome => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
  const verify = crypto.subtle.verify.bind(crypto.subtle); let hold = true;
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args);
    if (hold) {
      hold = false; entered.resolve(); await release.promise;
      if (outcome === 'verify-fails') throw new Error('Late native verification failure');
    }
    return result;
  });
  const failure = vi.fn();
  const pair = await start({ known: true, dropFrom: undefined, dropAt: 0, verifyA: undefined, verifyB: undefined, onFailure: failure });
  let completed = 0; void pair.a.then(() => {
    completed++;
  }, () => {
    completed++;
  }); void pair.b.then(() => {
    completed++;
  }, () => {
    completed++;
  });
  await entered.promise; await vi.advanceTimersByTimeAsync(1000);
  expect(failure).toHaveBeenCalled(); expect(completed).toBeLessThan(2);
  release.resolve(); const result = await Promise.allSettled([pair.a, pair.b]);
  const failed = result.filter(item => item.status === 'rejected'); expect(failed.length).toBeGreaterThan(0);
  for (const item of failed) if (item.status === 'rejected') expect(item.reason).toMatchObject({ name: 'HandshakeResponseUnconfirmedError', stage: 'confirmation' });
});

it('late MAC semantic commit checks wall expiry even before the delayed timer callback runs', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
  const verify = crypto.subtle.verify.bind(crypto.subtle); let hold = true;
  vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await verify(...args); if (hold) {
      hold = false; entered.resolve(); await release.promise;
    } return result;
  });
  const pair = await start({ known: true, dropFrom: undefined, dropAt: 0, verifyA: undefined, verifyB: undefined, onFailure: undefined });
  await entered.promise; vi.setSystemTime(1000); release.resolve();
  const result = await Promise.allSettled([pair.a, pair.b]);
  expect(result.some(item => item.status === 'rejected' && item.reason instanceof HandshakeResponseUnconfirmedError)).toBe(true);
});

it('a throwing immediate-shutdown callback is retained as retirement failure alongside timeout', async () => {
  const cleanup = new Error('Shutdown callback failed');
  const pair = await start({
    known: true,
    dropFrom: 'b',
    dropAt: 1,
    verifyA: undefined,
    verifyB: undefined,
    onFailure: () => {
      throw cleanup;
    },
  });
  await pair.whenReading({ side: 'a', count: 1 }); await vi.advanceTimersByTimeAsync(1000);
  await expect(pair.a).rejects.toBeInstanceOf(PipingRetirementError);
  await expect(pair.a).rejects.toMatchObject({ cause: cleanup, logicalError: { name: 'HandshakeResponseUnconfirmedError', stage: 'noise-2' } });
});

it.each(['timer-first', 'resume-before-timer'] as const)('anchors before registration await and joins delayed send: %s', async order => {
  const identity = await createNaidanPipingIdentity(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  releases.push(() => release.resolve()); const stop = new AbortController(); stops.push(stop);
  const failure = vi.fn(), receive = vi.fn(async () => new Uint8Array());
  const job = establishVerifiedNaidanPipingKeys({
    role: 'initiator',
    identity,
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    binding: new Uint8Array(32),
    signal: stop.signal,
    responseTimeoutMs: 1000,
    onResponseFailure: failure,
    channel: {
      async send() {
        entered.resolve(); await release.promise;
      },
      receive,
    },
  });
  jobs.push(job); void job.catch(() => {}); let settled = false; void job.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise;
  if (order === 'timer-first') {
    await vi.advanceTimersByTimeAsync(1000); expect(failure).toHaveBeenCalledOnce();
  } else vi.setSystemTime(1000);
  expect(settled).toBe(false); release.resolve();
  await expect(job).rejects.toMatchObject({ name: 'HandshakeResponseUnconfirmedError', stage: 'noise-2' });
  expect(receive).not.toHaveBeenCalled();
});

it('local ephemeral-key preparation has no response deadline before prepared registration', async () => {
  const identity = await createNaidanPipingIdentity(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  releases.push(() => release.resolve()); const stop = new AbortController(); stops.push(stop);
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'generateKey').mockImplementation(async (...args) => {
    const value = await generate(...args); entered.resolve(); await release.promise; return value;
  });
  const sent = Promise.withResolvers<void>();
  const job = establishVerifiedNaidanPipingKeys({
    role: 'initiator',
    identity,
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    binding: new Uint8Array(32),
    signal: stop.signal,
    responseTimeoutMs: 1000,
    onResponseFailure: undefined,
    channel: {
      async send() {
        sent.resolve();
      },
      async receive({ signal }) {
        signal.throwIfAborted();
        return new Promise<Uint8Array>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
  });
  jobs.push(job); void job.catch(() => {});
  await entered.promise; expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(100_000);
  release.resolve(); await sent.promise; await vi.advanceTimersByTimeAsync(1000);
  await expect(job).rejects.toMatchObject({ stage: 'noise-2' });
});
