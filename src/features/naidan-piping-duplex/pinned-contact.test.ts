// @vitest-environment node
import { expect, it, onTestFinished, vi } from 'vitest';
import { createNaidanPipingIdentity } from './noise-xx';
import { NaidanPipingDuplexSession } from './naidan-piping-duplex-session';
import type { PreparedPinnedConnection } from './naidan-piping-duplex-session';
import { FiniteMemoryRelay } from './finite-memory-relay.test-support';
import { FiniteTransferEndpoint } from './finite-transfer';
import { pinnedPeerRoutes } from './peer-routes';
import { encodeProtocolHeader } from './protocol-header';
import { joinBytes } from './bytes';
import { useOfflineScope } from './test-support';

useOfflineScope();
async function fixture() {
  const relay = new FiniteMemoryRelay(), stop = new AbortController();
  vi.mocked(fetch).mockImplementation(relay.fetch);
  const identities = await Promise.all([createNaidanPipingIdentity(), createNaidanPipingIdentity()]);
  identities.sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const sessions: NaidanPipingDuplexSession[] = [], unused = new Set<PreparedPinnedConnection>(), jobs: Promise<unknown>[] = [];
  const piping = { baseUrl: 'https://relay.invalid', policy: 'https-only' as const, requestTimeoutMs: 1000, handshakeResponseTimeoutMs: 1000 };
  const prepare = ({ index, heldContext }: { index: number; heldContext: Uint8Array | undefined }) => {
    const job = NaidanPipingDuplexSession.preparePinnedContact({
      piping,
      identity: identities[index]!,
      expectedPeer: identities[1 - index]!.publicKey,
      purpose: 'test/contact/v1',
      signal: stop.signal,
      heldContext,
      publicHandshakeData: new Uint8Array([index, 17]),
      handshakeData: new Uint8Array([index, 81]),
    }).then(result => {
      if (result.kind === 'candidate') unused.add(result); return result;
    });
    jobs.push(job); void job.catch(() => {}); return job;
  };
  const finish = ({ candidate }: { candidate: PreparedPinnedConnection }) => {
    unused.delete(candidate);
    const job = candidate.finish().then(session => {
      sessions.push(session); return session;
    }); jobs.push(job); void job.catch(() => {}); return job;
  };
  const knock = async () => {
    const routes = await pinnedPeerRoutes({ identity: identities[1]!, expectedPeer: identities[0]!.publicKey, origin: piping.baseUrl, purpose: 'test/contact/v1', signal: stop.signal });
    await new FiniteTransferEndpoint({ ...piping, timeoutMs: 1000 }).send({ route: routes.knockPath, bytes: joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([0x23])] }), signal: stop.signal });
  };
  onTestFinished(async () => {
    stop.abort(); await Promise.allSettled(jobs);
    await Promise.allSettled([...unused].map(candidate => candidate.dispose()));
    for (const session of sessions) session.abort({ reason: 'Test cleanup' });
    await Promise.allSettled(sessions.map(session => session.closed));
    expect(relay.occupied).toBe(0); relay.interrupt();
  });
  return { relay, stop, identities, piping, prepare, finish, knock, unused };
}

it.each([0, 1])('authenticates a restarting role %s before liveness and continues the same Noise candidate', async restarted => {
  const f = await fixture(), context = new Uint8Array(32).fill(7);
  const jobs = [0, 1].map(index => f.prepare({ index, heldContext: index === restarted ? undefined : context }));
  const [a, b] = await Promise.all(jobs);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  expect(a!.peerPublicHandshakeData).toEqual(new Uint8Array([1, 17]));
  // No seed/context or READY traffic starts before explicit adoption.
  expect(f.relay.posts.filter(post => post.bytes[13] === 0x21)).toHaveLength(1);
  expect(f.relay.occupied).toBe(0);
  const [left, right] = await Promise.all([f.finish({ candidate: a }), f.finish({ candidate: b })]);
  expect(left.contextId).toEqual(right.contextId); expect(left.peerHandshakeData).toEqual(new Uint8Array([1, 81]));
  expect(f.relay.posts.filter(post => post.bytes[13] === 0x21)).toHaveLength(1);
});

it('both absent means a new session; finishing consumes the prepared cipher only once', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  const first = f.finish({ candidate: a });
  await expect(a.finish()).rejects.toThrow('already consumed');
  await expect(a.dispose()).rejects.toThrow('already consumed');
  await Promise.all([first, f.finish({ candidate: b })]);
});

it('an old KNOCK with the same held context only authenticates a no-op, without READY', async () => {
  const f = await fixture(), heldContext = new Uint8Array(32).fill(9);
  const a = f.prepare({ index: 0, heldContext }), b = f.prepare({ index: 1, heldContext });
  await f.knock(); expect(await a).toEqual({ kind: 'same-connection' }); expect(await b).toEqual({ kind: 'same-connection' });
  expect(f.relay.posts.some(post => post.bytes[13] === 0x20)).toBe(false);
  expect(f.relay.occupied).toBe(0);
});

it('different held contexts converge through a candidate rather than accepting either old session', async () => {
  const f = await fixture();
  const a = f.prepare({ index: 0, heldContext: new Uint8Array(32).fill(7) }), b = f.prepare({ index: 1, heldContext: new Uint8Array(32).fill(8) });
  await f.knock();
  expect((await a).kind).toBe('candidate'); expect((await b).kind).toBe('candidate');
});

it('contact preparation can be aborted while idle without a polling loop', async () => {
  const f = await fixture(); f.piping.handshakeResponseTimeoutMs = 30;
  const job = f.prepare({ index: 0, heldContext: new Uint8Array(32) });
  await vi.waitFor(() => expect(f.relay.occupied).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(f.relay.posts).toHaveLength(0); expect(f.relay.gets).toHaveLength(1);
  f.stop.abort(new Error('User disconnected')); await expect(job).rejects.toThrow('User disconnected');
});

it('discarding an authenticated candidate prevents its later continuation', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  f.unused.delete(a); await a.dispose(); await expect(a.finish()).rejects.toThrow('already consumed');
  expect(f.relay.posts.some(post => post.bytes[13] === 0x20)).toBe(false);
});

it('authenticated status modification rejects only the candidate and releases its HTTP requests', async () => {
  const f = await fixture();
  // Our absent status is 39 plaintext bytes + tag16 + outer14 = 69.
  f.relay.transform = ({ bytes }) => {
    if (bytes[13] === 0x22 && bytes.length === 69) bytes[bytes.length - 1]! ^= 1;
    return bytes;
  };
  const a = f.prepare({ index: 0, heldContext: undefined }), b = f.prepare({ index: 1, heldContext: undefined });
  await expect(b).rejects.toBeDefined(); f.stop.abort(); await Promise.allSettled([a, b]);
  expect(f.relay.posts.some(post => post.bytes[13] === 0x20)).toBe(false);
});

it('public paths cannot be reused as private flight-key material and remain domain-separated', async () => {
  const f = await fixture();
  const common = { origin: f.piping.baseUrl, purpose: 'test/contact/v1', signal: f.stop.signal };
  const a = await pinnedPeerRoutes({ ...common, identity: f.identities[0]!, expectedPeer: f.identities[1]!.publicKey });
  const b = await pinnedPeerRoutes({ ...common, identity: f.identities[1]!, expectedPeer: f.identities[0]!.publicKey });
  expect(a.offerPath).toBe(b.offerPath); expect(a.knockPath).toBe(b.knockPath); expect(a.offerPath).not.toBe(a.knockPath);
  expect(a.handshakeRouteKey.extractable).toBe(false); await expect(crypto.subtle.exportKey('raw', a.handshakeRouteKey)).rejects.toThrow();
  const input = new Uint8Array([1, 2, 3]);
  const left = await crypto.subtle.sign('HMAC', a.handshakeRouteKey, input), right = await crypto.subtle.sign('HMAC', b.handshakeRouteKey, input);
  expect(new Uint8Array(left)).toEqual(new Uint8Array(right));
  const other = await pinnedPeerRoutes({ ...common, purpose: 'other/contact/v1', identity: f.identities[0]!, expectedPeer: f.identities[1]!.publicKey });
  expect(other.offerPath).not.toBe(a.offerPath); expect(other.knockPath).not.toBe(a.knockPath);
});

it('idle contact GETs have a finite body deadline once the relay starts responding', async () => {
  const f = await fixture(), cancellation = vi.fn(); f.piping.handshakeResponseTimeoutMs = 30;
  vi.mocked(fetch).mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([78]));
    },
    cancel: cancellation,
  })));
  const job = f.prepare({ index: 0, heldContext: new Uint8Array(32) });
  await expect(job).rejects.toBeDefined(); expect(cancellation).toHaveBeenCalledOnce();
});

it('an abandoned prepared cipher expires before it can publish a session', async () => {
  const f = await fixture(); f.piping.handshakeResponseTimeoutMs = 150;
  const [a, b] = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(() => a.assertAvailable()).toThrow(); expect(() => b.assertAvailable()).toThrow();
  f.unused.delete(a); f.unused.delete(b);
  await expect(a.finish()).rejects.toBeDefined(); await expect(b.finish()).rejects.toBeDefined();
  expect(f.relay.posts.some(post => post.bytes[13] === 0x20)).toBe(false);
});

it.each([Infinity, NaN, 0, -1, 1.5])('rejects an invalid contact deadline %s before starting requests', async value => {
  const f = await fixture(); f.piping.handshakeResponseTimeoutMs = value;
  await expect(f.prepare({ index: 0, heldContext: undefined })).rejects.toThrow('Invalid handshake response deadline');
  expect(fetch).not.toHaveBeenCalled();
});

it('READY response stalls use the contact deadline rather than the long DATA timeout', async () => {
  const f = await fixture(); f.piping.requestTimeoutMs = 120000; f.piping.handshakeResponseTimeoutMs = 200;
  const [a, b] = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  const held = Promise.withResolvers<void>();
  f.relay.holdSenderEof = ({ bytes }) => bytes[13] === 0x20 ? held.promise : Promise.resolve();
  const start = performance.now();
  const outcomes = await Promise.allSettled([f.finish({ candidate: a }), f.finish({ candidate: b })]);
  expect(outcomes.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(performance.now() - start).toBeLessThan(2000); expect(f.relay.occupied).toBe(0); held.resolve();
});

it('finishing contact READY clears its setup deadline without expiring active DATA', async () => {
  const f = await fixture(); f.piping.handshakeResponseTimeoutMs = 200;
  const [a, b] = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  if (!a || !b || a.kind !== 'candidate' || b.kind !== 'candidate') throw new Error('Expected a candidate');
  const [left, right] = await Promise.all([f.finish({ candidate: a }), f.finish({ candidate: b })]);
  let ended = false; void left.ended.then(() => {
    ended = true;
  });
  await new Promise(resolve => setTimeout(resolve, 250)); expect(ended).toBe(false);
  const incoming = right.incomingStreams[Symbol.asyncIterator](), opening = left.openStream({ signal: undefined });
  const remote = (await incoming.next()).value!, local = await opening;
  const writer = local.writable.getWriter(), reader = remote.readable.getReader();
  await writer.write(new Uint8Array([4, 2])); expect((await reader.read()).value).toEqual(new Uint8Array([4, 2]));
  writer.releaseLock(); reader.releaseLock();
});

it.each(['first', 'second', 'third'] as const)('a replayed %s Noise flight cannot authenticate a fresh contact', async flight => {
  const f = await fixture();
  const previous = await Promise.all([f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })]);
  for (const candidate of previous) {
    if (candidate.kind !== 'candidate') throw new Error('Expected authentication');
    f.unused.delete(candidate); await candidate.dispose();
  }
  const kind = flight === 'first' ? 0x21 : 0x22, length = flight === 'second' ? 110 : 78;
  const captured = f.relay.posts.find(post => post.bytes[13] === kind && post.bytes.length === length)!.bytes;
  let replayed = false;
  f.relay.transform = ({ bytes }) => {
    if (!replayed && bytes[13] === kind && bytes.length === length) {
      replayed = true;
      // Retain the new attempt/path so this checks Noise, not a missing route.
      const prefix = flight === 'first' ? 46 : 14; bytes.set(captured.subarray(prefix), prefix);
    }
    return bytes;
  };
  const jobs = [f.prepare({ index: 0, heldContext: undefined }), f.prepare({ index: 1, heldContext: undefined })];
  const observed = jobs.map(job => job.then(() => 'unexpected authentication' as const, () => 'rejected' as const));
  expect(await Promise.race(observed)).toBe('rejected'); expect(replayed).toBe(true);
  f.stop.abort(); await Promise.allSettled(jobs);
  expect(f.relay.posts.some(post => post.bytes[13] === 0x20)).toBe(false);
});
