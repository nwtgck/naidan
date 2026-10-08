// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { createNaidanPipingIdentity, NaidanPipingPeerEndpoint } from './index';
import type { NaidanPipingDuplexOptions, NaidanPipingPeerCandidate } from './index';
import { MemoryRelay } from './memory-relay.test-support';

const piping: NaidanPipingDuplexOptions = {
  baseUrl: 'https://memory.invalid',
  policy: 'https-only',
  requestTimeoutMs: 1000,
  repairTimeoutMs: 100,
  candidateConfirmationTimeoutMs: 1000,
  handshakeResponseTimeoutMs: 2000,
  liveness: { intervalMs: 100, responseTimeoutMs: 3000 },
  pacing: { minimumMs: 2, idleResendIntervalMs: 20, retryBaseMs: 4, retryMaximumMs: 20 },
};

afterEach(() => vi.unstubAllGlobals());

async function next({ iterator }: { iterator: AsyncIterator<NaidanPipingPeerCandidate> }): Promise<NaidanPipingPeerCandidate> {
  const result = await iterator.next(); if (result.done) throw new Error('Missing candidate'); return result.value;
}

it.each(['fast', 'production'] as const)('automatically authenticates, admits, and closes on stable paths with %s pacing', async profile => {
  const settings = profile === 'production' ? { ...piping, liveness: { intervalMs: 15000, responseTimeoutMs: 75000 }, handshakeResponseTimeoutMs: 75000, pacing: { minimumMs: 20, idleResendIntervalMs: 15000, retryBaseMs: 250, retryMaximumMs: 5000 } } : piping;
  const relay = new MemoryRelay(), urls = new Set<string>(); let active = 0, peak = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    urls.add(String(input)); active++; peak = Math.max(peak, active);
    try {
      return await relay.request({ input, init });
    } finally {
      active--;
    }
  }));
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const lifetime = new AbortController();
  const endpoints = await promiseAllKeyed({
    a: NaidanPipingPeerEndpoint.create({ piping: settings, identity: identities.a, expectedPeer: identities.b.publicKey, purpose: 'test/pinned-peer', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
    b: NaidanPipingPeerEndpoint.create({ piping: settings, identity: identities.b, expectedPeer: identities.a.publicKey, purpose: 'test/pinned-peer', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
  });
  const ai = endpoints.a.candidates[Symbol.asyncIterator](), bi = endpoints.b.candidates[Symbol.asyncIterator]();
  try {
    endpoints.a.beginCycle(); endpoints.b.beginCycle();
    const candidates = await promiseAllKeyed({ a: next({ iterator: ai }), b: next({ iterator: bi }) });
    expect(candidates.a.contextId).toEqual(candidates.b.contextId);
    const sessions = await promiseAllKeyed({ a: candidates.a.activate({ signal: lifetime.signal }), b: candidates.b.activate({ signal: lifetime.signal }) });
    expect(sessions.a.peerIdentity).toEqual(identities.b.publicKey);
    expect(urls.size).toBe(2); expect(peak).toBeLessThanOrEqual(4);
    const closing = sessions.a.close({ noticeTimeoutMs: 1000, signal: undefined });
    expect((await sessions.b.ended).kind).toBe('peer-closed');
    expect(await closing).toEqual({ notification: 'acknowledged' });
  } finally {
    endpoints.a.stop({ reason: 'Test complete' }); endpoints.b.stop({ reason: 'Test complete' });
    await promiseAllKeyed({ a: endpoints.a.closed, b: endpoints.b.closed }); lifetime.abort();
  }
  expect(relay.occupied).toBe(0); expect(active).toBe(0);
});

it.each([0, 1] as const)('detects peer %s reload on the same paths before the incumbent liveness timeout', async reload => {
  const relay = new MemoryRelay(), urls = new Set<string>(); let active = 0, peak = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    urls.add(String(input)); active++; peak = Math.max(peak, active);
    try {
      return await relay.request({ input, init });
    } finally {
      active--;
    }
  }));
  const identityValues = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const identities = [identityValues.a, identityValues.b].sort((left, right) => {
    for (let index = 0; index < 32; index++) if (left.publicKey[index] !== right.publicKey[index]) return left.publicKey[index]! - right.publicKey[index]!;
    return 0;
  });
  const lifetime = new AbortController();
  const make = ({ index }: { index: number }) => NaidanPipingPeerEndpoint.create({
    piping,
    identity: identities[index]!,
    expectedPeer: identities[1 - index]!.publicKey,
    purpose: 'test/pinned-reload',
    publicHandshakeData: undefined,
    handshakeData: undefined,
    signal: lifetime.signal,
  });
  const endpoints = await Promise.all(identities.map((_, index) => make({ index })));
  const iterators = endpoints.map(endpoint => endpoint.candidates[Symbol.asyncIterator]());
  try {
    for (const endpoint of endpoints) endpoint.beginCycle();
    const initialCandidates = await Promise.all(iterators.map(iterator => next({ iterator })));
    const sessions = await Promise.all(initialCandidates.map(candidate => candidate.activate({ signal: lifetime.signal })));
    const previousContext = initialCandidates[0]!.contextId;
    let survivorEnded = false;
    void sessions[1 - reload]!.ended.then(() => {
      survivorEnded = true;
    });
    endpoints[reload]!.stop({ reason: 'Browser reload without a close notification' }); await endpoints[reload]!.closed;
    endpoints[reload] = await make({ index: reload }); iterators[reload] = endpoints[reload]!.candidates[Symbol.asyncIterator]();
    endpoints[reload]!.beginCycle();
    const replacements = await Promise.all(iterators.map(iterator => next({ iterator })));
    expect(survivorEnded).toBe(false);
    expect(replacements[0]!.contextId).toEqual(replacements[1]!.contextId);
    expect(replacements[0]!.contextId).not.toEqual(previousContext);
    sessions[1 - reload]!.abort({ reason: 'RPC retired old work before accepting replacement' }); await sessions[1 - reload]!.closed;
    const fresh = await Promise.all(replacements.map(candidate => candidate.activate({ signal: lifetime.signal })));
    expect(fresh).toHaveLength(2); expect(urls.size).toBe(2); expect(peak).toBeLessThanOrEqual(4);
  } finally {
    for (const endpoint of endpoints) endpoint.stop({ reason: 'Test complete' });
    await Promise.all(endpoints.map(endpoint => endpoint.closed)); lifetime.abort();
  }
  expect(relay.occupied).toBe(0); expect(active).toBe(0);
});

it.each(['blocked-write', 'lost-ack', 'simultaneous'] as const)('bounds authenticated close with %s', async mode => {
  const relay = new MemoryRelay();
  vi.stubGlobal('fetch', vi.fn((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => relay.request({ input, init })));
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const lifetime = new AbortController();
  const endpoints = await promiseAllKeyed({
    a: NaidanPipingPeerEndpoint.create({ piping, identity: identities.a, expectedPeer: identities.b.publicKey, purpose: 'test/close-faults', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
    b: NaidanPipingPeerEndpoint.create({ piping, identity: identities.b, expectedPeer: identities.a.publicKey, purpose: 'test/close-faults', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
  });
  let writing: Promise<void> | undefined;
  try {
    endpoints.a.beginCycle(); endpoints.b.beginCycle();
    const candidates = await promiseAllKeyed({ a: next({ iterator: endpoints.a.candidates[Symbol.asyncIterator]() }), b: next({ iterator: endpoints.b.candidates[Symbol.asyncIterator]() }) });
    const sessions = await promiseAllKeyed({ a: candidates.a.activate({ signal: lifetime.signal }), b: candidates.b.activate({ signal: lifetime.signal }) });
    switch (mode) {
    case 'blocked-write': {
      const incoming = sessions.b.incomingStreams[Symbol.asyncIterator]().next();
      const opened = sessions.a.openStream({ signal: lifetime.signal });
      const streams = await promiseAllKeyed({ local: opened, remote: incoming }); expect(streams.remote.done).toBe(false);
      let settled = false; writing = streams.local.writable.getWriter().write(new Uint8Array(256 * 1024));
      void writing.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });
      // The receiver deliberately does not consume any of the 64 KiB window.
      await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
      expect(await sessions.a.close({ noticeTimeoutMs: 1000, signal: undefined })).toEqual({ notification: 'acknowledged' });
      await expect(writing).rejects.toBeDefined(); expect((await sessions.b.ended).kind).toBe('peer-closed'); break;
    }
    case 'lost-ack': {
      const { pinnedPeerRoutes } = await import('./peer-routes');
      const routes = await pinnedPeerRoutes({ identity: identities.b, expectedPeer: identities.a.publicKey, origin: piping.baseUrl, purpose: 'test/close-faults', signal: lifetime.signal });
      relay.transformReplies({ transform: ({ route, bytes }) => new URL(route).pathname === `/${routes.send}` ? new Uint8Array() : bytes });
      expect(await sessions.a.close({ noticeTimeoutMs: 100, signal: undefined })).toEqual({ notification: 'unconfirmed' });
      expect((await sessions.b.ended).kind).toBe('peer-closed'); break;
    }
    case 'simultaneous': {
      const closed = await promiseAllKeyed({ a: sessions.a.close({ noticeTimeoutMs: 300, signal: undefined }), b: sessions.b.close({ noticeTimeoutMs: 300, signal: undefined }) });
      expect(['acknowledged', 'unconfirmed']).toContain(closed.a.notification); expect(['acknowledged', 'unconfirmed']).toContain(closed.b.notification);
      expect((await sessions.a.ended).kind).toBe('local-stop'); expect((await sessions.b.ended).kind).toBe('local-stop'); break;
    }
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
  } finally {
    endpoints.a.stop({ reason: 'Test complete' }); endpoints.b.stop({ reason: 'Test complete' });
    await promiseAllKeyed({ a: endpoints.a.closed, b: endpoints.b.closed }); await writing?.catch(() => {}); lifetime.abort();
  }
  expect(relay.occupied).toBe(0);
});

it('starts a second explicit cycle after logical retirement and coalesces repeated starts', async () => {
  const relay = new MemoryRelay();
  vi.stubGlobal('fetch', vi.fn((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => relay.request({ input, init })));
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const lifetime = new AbortController();
  const endpoints = await promiseAllKeyed({
    a: NaidanPipingPeerEndpoint.create({ piping, identity: identities.a, expectedPeer: identities.b.publicKey, purpose: 'test/second-cycle', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
    b: NaidanPipingPeerEndpoint.create({ piping, identity: identities.b, expectedPeer: identities.a.publicKey, purpose: 'test/second-cycle', publicHandshakeData: undefined, handshakeData: undefined, signal: lifetime.signal }),
  });
  const ai = endpoints.a.candidates[Symbol.asyncIterator](), bi = endpoints.b.candidates[Symbol.asyncIterator]();
  let priorContext: Uint8Array | undefined;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      endpoints.a.beginCycle(); endpoints.a.beginCycle(); endpoints.b.beginCycle(); endpoints.b.beginCycle();
      const candidates = await promiseAllKeyed({ a: next({ iterator: ai }), b: next({ iterator: bi }) });
      if (priorContext) expect(candidates.a.contextId).not.toEqual(priorContext);
      priorContext = candidates.a.contextId;
      // A second request does not discard an already authenticated candidate.
      endpoints.a.beginCycle(); endpoints.b.beginCycle();
      const sessions = await promiseAllKeyed({ a: candidates.a.activate({ signal: lifetime.signal }), b: candidates.b.activate({ signal: lifetime.signal }) });
      sessions.a.abort({ reason: 'Old cycle retired' }); sessions.b.abort({ reason: 'Old cycle retired' });
      await promiseAllKeyed({ a: sessions.a.closed, b: sessions.b.closed });
    }
  } finally {
    endpoints.a.stop({ reason: 'Test complete' }); endpoints.b.stop({ reason: 'Test complete' });
    await promiseAllKeyed({ a: endpoints.a.closed, b: endpoints.b.closed }); lifetime.abort();
  }
  expect(relay.occupied).toBe(0);
});
