// @vitest-environment node
import { expect, it, onTestFinished, vi } from 'vitest';
import { OrderedSession } from '@/features/naidan-piping-duplex/ordered-session';
import { FiniteTransferEndpoint } from '@/features/naidan-piping-duplex/finite-transfer';
import { FiniteMemoryRelay } from '@/features/naidan-piping-duplex/finite-memory-relay.test-support';
import { keyPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
async function pair({ relay = new FiniteMemoryRelay() }: { relay?: FiniteMemoryRelay } = {}) {
  const keys = await keyPair(); vi.mocked(fetch).mockImplementation(relay.fetch);
  const signal = new AbortController(), options = { baseUrl: 'https://relay.invalid', policy: 'https-only' as const, timeoutMs: 3000 };
  const jobs = [
    OrderedSession.create({ keys: keys.a, endpoint: new FiniteTransferEndpoint(options), signal: signal.signal }),
    OrderedSession.create({ keys: keys.b, endpoint: new FiniteTransferEndpoint(options), signal: signal.signal }),
  ];
  onTestFinished(async () => {
    signal.abort(); await Promise.allSettled(jobs.map(async job => (await job).closed)); relay.interrupt();
  });
  const [a, b] = await Promise.all(jobs); return { a: a!, b: b!, relay, signal };
}

it('transfers a prepared 1 MiB through real encryption and one large data POST', async () => {
  const { a, b, relay } = await pair();
  const incoming = b.incomingStreams[Symbol.asyncIterator](), request = a.openStream({ signal: undefined });
  const right = await incoming.next(); if (right.done) throw new Error('No stream'); const left = await request;
  const writer = left.writable.getWriter(), reader = right.value.readable.getReader();
  const before = relay.posts.length, input = new Uint8Array(1048576).fill(87), writing = writer.write(input);
  let received = 0;
  while (received < input.length) {
    const item = await reader.read(); expect(item.done).toBe(false); expect(item.value!.every(byte => byte === 87)).toBe(true); received += item.value!.length;
  }
  await writing;
  expect(relay.posts.slice(before).filter(post => post.bytes.length > 500000)).toHaveLength(1);
  await writer.close(); expect((await reader.read()).done).toBe(true);
  const responseWriter = right.value.writable.getWriter(); await responseWriter.close();
  expect((await left.readable.getReader().read()).done).toBe(true);
  await Promise.all([left.closed, right.value.closed]);
  const notice = await a.close({ signal: undefined }); expect(notice.notification).toBe('acknowledged'); await b.closed;
  expect((await b.ended).kind).toBe('peer-closed');
});

it('serializes simultaneous CLOSE and joins both acknowledgements', async () => {
  const { a, b } = await pair();
  const notices = await Promise.all([a.close({ signal: undefined }), b.close({ signal: undefined })]);
  expect(notices).toEqual([{ notification: 'acknowledged' }, { notification: 'acknowledged' }]);
  await Promise.all([a.closed, b.closed]);
});

it('finishes failure lifetimes after the relay disappears', async () => {
  const { a, b, relay } = await pair(); relay.interrupt();
  await Promise.all([a.ended, b.ended]); await Promise.all([a.closed, b.closed]);
  await expect(a.openStream({ signal: undefined })).rejects.toThrow();
});

it('bounds graceful close when the peer no longer responds', async () => {
  const { a, b } = await pair(); b.abort({ reason: 'Simulated reload' }); await b.closed;
  const notice = await a.close({ noticeTimeoutMs: 30, signal: undefined }); expect(notice.notification).toBe('unconfirmed'); await a.closed;
});

it('does not acknowledge a CLOSE_ACK record until its complete finite body has been checked', async () => {
  const { a, b, relay } = await pair(); let body = 0;
  relay.transform = ({ bytes }) => {
    if (++body !== 2) return bytes;
    const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes); return trailing;
  };
  const notice = await a.close({ signal: undefined });
  expect(notice.notification).toBe('unconfirmed');
  await Promise.all([a.closed, b.closed]);
});

it('holds an early OPEN while one READY sender response is delayed', async () => {
  const relay = new FiniteMemoryRelay(), release = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  let first = true;
  relay.holdSenderEof = () => {
    if (!first) return Promise.resolve();
    first = false; held.resolve(); return release.promise;
  };
  const keys = await keyPair(), signal = new AbortController(); vi.mocked(fetch).mockImplementation(relay.fetch);
  const options = { baseUrl: 'https://relay.invalid', policy: 'https-only' as const, timeoutMs: 3000 };
  const jobs = [
    OrderedSession.create({ keys: keys.a, endpoint: new FiniteTransferEndpoint(options), signal: signal.signal }),
    OrderedSession.create({ keys: keys.b, endpoint: new FiniteTransferEndpoint(options), signal: signal.signal }),
  ];
  onTestFinished(async () => {
    release.resolve(); signal.abort(); await Promise.allSettled(jobs.map(async job => (await job).closed)); relay.interrupt();
  });
  await held.promise;
  const published = await Promise.race(jobs); let opened = false;
  const opening = published.openStream({ signal: undefined }); void opening.then(() => {
    opened = true;
  }, () => {});
  await new Promise<void>(resolve => setTimeout(resolve, 10)); expect(opened).toBe(false);
  release.resolve(); const both = await Promise.all(jobs), other = both.find(connection => connection !== published)!;
  const received = await other.incomingStreams[Symbol.asyncIterator]().next(); expect(received.done).toBe(false);
  await opening;
  published.abort({ reason: 'done' }); other.abort({ reason: 'done' }); await Promise.all(both.map(connection => connection.closed));
  expect(relay.occupied).toBe(0);
});
