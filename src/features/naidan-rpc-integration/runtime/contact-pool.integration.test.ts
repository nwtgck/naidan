// @vitest-environment node
import { expect, it, vi, onTestFinished } from 'vitest';
import { createNaidanPipingIdentity, NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex';
import type { PreparedPinnedConnection } from '@/features/naidan-piping-duplex';
import { FiniteMemoryRelay } from '@/features/naidan-piping-duplex/finite-memory-relay.test-support';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';
import { createPipingFetchPool } from './test-support/piping-pool';

useOfflineScope();

it.each(['initiator', 'responder'] as const)('authenticates beside two blocked DATA sends within six owned HTTP operations (%s)', async survivorRole => {
  const relay = new FiniteMemoryRelay(), stop = new AbortController(), held = Promise.withResolvers<void>();
  const pools = [0, 1, 2].map(() => createPipingFetchPool({ capacity: 6, request: ({ input, init }) => relay.fetch(input, init) }));
  vi.mocked(fetch).mockImplementation((input, init) => {
    const tag = Number(new Headers(init?.headers).get('X-Test-Client'));
    return pools[tag]!.request({ input, init });
  });
  const keys = await Promise.all([createNaidanPipingIdentity(), createNaidanPipingIdentity(), createNaidanPipingIdentity()]);
  keys.sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const identities = survivorRole === 'initiator' ? keys : [...keys].reverse();
  const config = ({ local, remote }: { local: number; remote: number }) => ({
    identity: identities[local]!,
    expectedPeer: identities[remote]!.publicKey,
    signal: stop.signal,
    piping: { baseUrl: 'https://relay.invalid', policy: 'https-only' as const, requestTimeoutMs: 5000, handshakeResponseTimeoutMs: 5000, headers: [{ name: 'X-Test-Client', value: String(local) }] },
  });
  const sessions: NaidanPipingDuplexSession[] = [], pending = new Set<PreparedPinnedConnection>(), jobs: Promise<unknown>[] = [];
  const own = (job: Promise<NaidanPipingDuplexSession>) => {
    const tracked = job.then(session => {
      sessions.push(session); return session;
    }); jobs.push(tracked); void tracked.catch(() => {}); return tracked;
  };
  onTestFinished(async () => {
    stop.abort(); held.resolve(); for (const session of sessions) session.abort({ reason: 'Test complete' });
    await Promise.allSettled(jobs); await Promise.allSettled([...pending].map(value => value.dispose()));
    await Promise.allSettled(sessions.map(session => session.closed));
    expect(relay.occupied).toBe(0); expect(pools[0]!.stats).toMatchObject({ active: 0, queued: 0 }); relay.interrupt();
  });
  const [a, b, c, d] = await Promise.all([
    own(NaidanPipingDuplexSession.connectPinned(config({ local: 0, remote: 1 }))), own(NaidanPipingDuplexSession.connectPinned(config({ local: 1, remote: 0 }))),
    own(NaidanPipingDuplexSession.connectPinned(config({ local: 0, remote: 2 }))), own(NaidanPipingDuplexSession.connectPinned(config({ local: 2, remote: 0 }))),
  ]);
  // Hold only the diagnostic response EOF, after the peer consumed the DATA.
  relay.holdSenderEof = ({ bytes }) => bytes[13] === 0x20 && bytes.length > 4096 ? held.promise : Promise.resolve();
  for (const [sender, receiver] of [[a!, b!], [c!, d!]] as const) {
    const incoming = receiver.incomingStreams[Symbol.asyncIterator]();
    const local = await sender.openStream({ signal: stop.signal }), remote = (await incoming.next()).value!;
    const writer = local.writable.getWriter(), reader = remote.readable.getReader();
    const writing = writer.write(new Uint8Array(8192).fill(61)); void writing.catch(() => {}); jobs.push(writing);
    const got = await reader.read(); expect(got.value?.length).toBe(8192);
    writer.releaseLock(); reader.releaseLock();
  }
  const prepare = ({ local, remote, heldContext }: { local: number; remote: number; heldContext: Uint8Array | undefined }) => {
    const job = NaidanPipingDuplexSession.preparePinnedContact({ ...config({ local, remote }), heldContext }).then(value => {
      if (value.kind === 'candidate') pending.add(value); return value;
    });
    void job.catch(() => {}); jobs.push(job); return job;
  };
  const otherListener = prepare({ local: 0, remote: 2, heldContext: c!.contextId }); void otherListener.catch(() => {});
  const candidateA = prepare({ local: 0, remote: 1, heldContext: a!.contextId });
  await vi.waitFor(() => expect(pools[0]!.stats.active).toBe(6));
  b!.abort({ reason: 'Page disappeared' }); await b!.closed;
  const candidateB = prepare({ local: 1, remote: 0, heldContext: undefined });
  const [left, right] = await Promise.all([candidateA, candidateB]);
  if (left!.kind !== 'candidate' || right!.kind !== 'candidate') throw new Error('Expected a fresh contact');
  // Neither old sender has finished; control authentication did not wait for it.
  expect(pools[0]!.stats.active).toBeGreaterThanOrEqual(4); expect(pools[0]!.stats.peak).toBeLessThanOrEqual(6);
  const old = a!.contextId; a!.abort({ reason: 'Adopt authenticated contact' }); await a!.closed;
  pending.delete(left); pending.delete(right);
  const [nextA, nextB] = await Promise.all([own(left.finish()), own(right.finish())]);
  expect(nextA!.contextId).toEqual(nextB!.contextId); expect(nextA!.contextId).not.toEqual(old);
  expect(pools[0]!.stats.peak).toBeLessThanOrEqual(6);
});
