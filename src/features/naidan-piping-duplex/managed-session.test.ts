// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { NaidanPipingDuplexSession, createNaidanPipingIdentity, createNaidanPipingCode } from '@/features/naidan-piping-duplex';
import type { NaidanPipingDuplexOptions } from '@/features/naidan-piping-duplex';
import { startPinnedConnection } from '@/features/naidan-piping-duplex/connection';
import { FiniteEndpoint } from '@/features/naidan-piping-duplex/finite';

type Pending = {
  bytes: Uint8Array | undefined;
  resolve: ReturnType<typeof Promise.withResolvers<Response>>['resolve'];
  reject: ReturnType<typeof Promise.withResolvers<Response>>['reject'];
  cleanup: () => void;
};
type Slot = { sender: Pending | undefined; receiver: Pending | undefined };

/** Test-only finite relay: no key, stream state, or peer identity lives here. */
class MemoryRelay {
  private readonly slots = new Map<string, Slot>();
  private transform: ({ route, bytes }: { route: string; bytes: Uint8Array }) => Uint8Array = ({ bytes }) => bytes;
  transformReplies({ transform }: { transform: ({ route, bytes }: { route: string; bytes: Uint8Array }) => Uint8Array }): void {
    this.transform = transform;
  }
  interrupt(): number {
    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      for (const pending of [slot.sender, slot.receiver]) {
        pending?.cleanup();
        pending?.reject(new Error('In-memory relay interrupted'));
      }
    }
    return slots.length;
  }
  get occupied(): number {
    return this.slots.size;
  }
  request({ input, init }: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }): Promise<Response> {
    const url = String(input), side = init?.method === 'POST' ? 'sender' : 'receiver';
    const signal = init?.signal;
    if (!signal) throw new Error('Every request needs a lifetime signal');
    signal.throwIfAborted();
    let slot = this.slots.get(url);
    if (!slot) {
      slot = { sender: undefined, receiver: undefined }; this.slots.set(url, slot);
    }
    if (slot[side]) {
      const diagnostic = side === 'sender'
        ? `[ERROR] Another sender has been connected on '${new URL(url).pathname}'.`
        : '[ERROR] The number of receivers has reached limits.';
      return Promise.resolve(new Response(diagnostic, { status: 400 }));
    }
    const pending = Promise.withResolvers<Response>();
    const abort = () => {
      if (slot[side] === entry) slot[side] = undefined;
      if (!slot.sender && !slot.receiver) this.slots.delete(url);
      signal.removeEventListener('abort', abort);
      pending.reject(signal.reason);
    };
    const body = init?.body;
    if (body !== undefined && !(body instanceof Uint8Array)) throw new Error('Finite bytes required');
    const entry: Pending = { bytes: body instanceof Uint8Array ? new Uint8Array(body) : undefined, resolve: pending.resolve, reject: pending.reject,
      cleanup: () => signal.removeEventListener('abort', abort) };
    slot[side] = entry;
    signal.addEventListener('abort', abort, { once: true });
    if (slot.sender && slot.receiver) {
      const sender = slot.sender, receiver = slot.receiver;
      sender.cleanup(); receiver.cleanup();
      this.slots.delete(url);
      sender.resolve(new Response('sent', { status: 200 }));
      receiver.resolve(new Response(new Uint8Array(this.transform({ route: url, bytes: sender.bytes ? new Uint8Array(sender.bytes) : new Uint8Array() })), { status: 200 }));
    }
    return pending.promise;
  }
}

const options: NaidanPipingDuplexOptions = {
  baseUrl: 'https://relay.invalid', policy: 'https-only',
  requestTimeoutMs: 500, repairTimeoutMs: 30, connectionTimeoutMs: 3000, handshakeRetentionMs: 150,
  pacing: { minimumMs: 2, heartbeatMs: 30, retryBaseMs: 10, retryMaximumMs: 50 },
};
const controllers = new Set<AbortController>();
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in unit test'));
});
afterEach(() => {
  for (const controller of controllers) controller.abort(); controllers.clear(); vi.restoreAllMocks();
});

function setup() {
  const relay = new MemoryRelay();
  // This callback implements the standard fetch signature, not a Naidan-owned call contract.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => relay.request({ input, init }));
  const stop = new AbortController(); controllers.add(stop);
  return { relay, stop };
}
async function sessions({ signal }: { signal: AbortSignal }) {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const code = createNaidanPipingCode();
  return promiseAllKeyed({
    a: NaidanPipingDuplexSession.connect({ piping: options, code, role: 'initiator', identity: identities.a,
      expectedPeer: identities.b.publicKey, signal }),
    b: NaidanPipingDuplexSession.connect({ piping: options, code, role: 'responder', identity: identities.b,
      expectedPeer: identities.a.publicKey, signal }),
  });
}
async function readAll({ readable }: { readable: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
  const reader = readable.getReader(), chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read(); if (next.done) break; chunks.push(next.value);
  }
  const output = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
  let at = 0; for (const item of chunks) {
    output.set(item, at); at += item.length;
  }
  return output;
}

test('managed API owns both directions, large writes, half-close, and complete cleanup', async () => {
  const { relay, stop } = setup();
  const { a, b } = await sessions({ signal: stop.signal });
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const left = await a.openStream({ signal: undefined }), accepted = await incoming.next();
  if (accepted.done) throw new Error('Missing incoming stream');
  const right = accepted.value;
  const body = new Uint8Array(196609); for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const outgoing = left.writable.getWriter(), received = readAll({ readable: right.readable });
  await outgoing.write(body); await outgoing.close();
  expect(await received).toEqual(body);
  // A completed sending half does not prevent receiving the response.
  const response = readAll({ readable: left.readable });
  const writer = right.writable.getWriter(); await writer.write(new Uint8Array([8, 5, 3])); await writer.close();
  expect(await response).toEqual(new Uint8Array([8, 5, 3]));
  await Promise.all([left.closed, right.closed]);
  await Promise.all([a.drain({ signal: undefined }), b.drain({ signal: undefined })]);
  expect((await incoming.next()).done).toBe(true);
  stop.abort(); await Promise.all([a.closed, b.closed]);
  expect(relay.occupied).toBe(0);
});

test('idle lifetime cancellation settles incoming and outstanding streams without waiting for new I/O', async () => {
  const { relay, stop } = setup();
  const { a, b } = await sessions({ signal: stop.signal });
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const pending = incoming.next();
  const rejected = expect(pending).rejects.toThrow();
  stop.abort(); await rejected;
  await Promise.all([a.closed, b.closed]); expect(relay.occupied).toBe(0);
});

test('cancellation during discovery rejects connection and leaves no relay requests', async () => {
  const { relay, stop } = setup(), identity = await createNaidanPipingIdentity();
  const peer = await createNaidanPipingIdentity();
  const pending = NaidanPipingDuplexSession.connect({ piping: options, code: 'ABCD-EFGH', role: 'initiator', identity,
    expectedPeer: peer.publicKey, signal: stop.signal });
  const rejected = expect(pending).rejects.toBeDefined();
  stop.abort(); await rejected; expect(relay.occupied).toBe(0);
});

test('unknown pins cannot be replaced with code-only authentication', async () => {
  const { relay, stop } = setup(), identity = await createNaidanPipingIdentity();
  await expect(NaidanPipingDuplexSession.connect({ piping: options, code: 'ABCD-EFGH', role: 'initiator', identity,
    expectedPeer: new Uint8Array(), signal: stop.signal })).rejects.toThrow();
  expect(relay.occupied).toBe(0);
});

test('configuration is validated before opening network requests', async () => {
  const { relay, stop } = setup();
  const identity = await createNaidanPipingIdentity();
  for (const baseUrl of ['http://evil.invalid', 'https://user:pass@relay.invalid/', 'https://relay.invalid/?secret=1']) {
    await expect(NaidanPipingDuplexSession.connect({ piping: { ...options, baseUrl }, code: 'ABCD-EFGH', role: 'initiator',
      identity, expectedPeer: identity.publicKey, signal: stop.signal })).rejects.toThrow();
  }
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); expect(relay.occupied).toBe(0);
});

test('different upper transport profiles are bound into authentication and cannot both become ready', async () => {
  const { relay, stop } = setup();
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const endpoint = () => new FiniteEndpoint({ baseUrl: options.baseUrl, policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
  const common = { code: 'ABCD-EFGH', signal: stop.signal, activeTimeoutMs: 500, completionLeaseMs: 50, intervalMs: 2 };
  const a = await startPinnedConnection({ ...common, role: 'initiator', identity: identities.a, expectedPeer: identities.b.publicKey,
    endpoint: endpoint(), purpose: new Uint8Array([1]) });
  const b = await startPinnedConnection({ ...common, role: 'responder', identity: identities.b, expectedPeer: identities.a.publicKey,
    endpoint: endpoint(), purpose: new Uint8Array([2]) });
  const results = await Promise.allSettled([a.ready, b.ready]);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  stop.abort(); await Promise.allSettled([a.completion, b.completion]);
  expect(relay.occupied).toBe(0);
});


test('a successful POST without peer acceptance leaves the write pending', async () => {
  const { relay, stop } = setup();
  const { a, b } = await sessions({ signal: stop.signal });
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const stream = await a.openStream({ signal: undefined });
  const accepted = await incoming.next();
  if (accepted.done) throw new Error('Missing incoming stream');
  let dropped = 0;
  relay.transformReplies({ transform: ({ bytes }) => {
    if (bytes[0] !== 2) return bytes;
    dropped++;
    return new Uint8Array();
  } });
  const writer = stream.writable.getWriter();
  let completed = false;
  const writing = writer.write(new Uint8Array([4, 3, 2, 1])).then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(dropped).toBeGreaterThanOrEqual(2));
  expect(completed).toBe(false);
  relay.transformReplies({ transform: ({ bytes }) => bytes });
  const result = readAll({ readable: accepted.value.readable });
  await writing; await writer.close();
  expect(await result).toEqual(new Uint8Array([4, 3, 2, 1]));
  stop.abort(); await Promise.all([a.closed, b.closed]);
  expect(relay.occupied).toBe(0);
});

test('concurrent streams recover from relay state loss, corrupt bytes, and replayed ciphertext without a server', async () => {
  const { relay, stop } = setup();
  const { a, b } = await sessions({ signal: stop.signal });
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const pairs = [];
  for (let index = 0; index < 4; index++) {
    const left = await a.openStream({ signal: undefined });
    const accepted = await incoming.next();
    if (accepted.done) throw new Error('Missing incoming stream');
    pairs.push({ left, right: accepted.value });
  }
  let target: string | undefined, recorded: Uint8Array | undefined, altered = 0, replayed = 0;
  relay.transformReplies({ transform: ({ route, bytes }) => {
    if (bytes[0] !== 2) return bytes;
    if (!target) {
      target = route; recorded = bytes.slice(); return bytes;
    }
    if (route !== target) return bytes;
    if (!altered) {
      const corrupt = bytes.slice(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      altered++; return corrupt;
    }
    if (!replayed && recorded) {
      replayed++; return recorded.slice();
    }
    return bytes;
  } });
  const allowReading = Promise.withResolvers<void>();
  const transfers = pairs.map(async ({ left, right }, index) => {
    const body = Uint8Array.from({ length: 65537 + index }, (_, offset) => (offset * 13 + index * 17) % 251);
    const reply = new Uint8Array([index, 9, 7]);
    // Hold receive credit at one window so interruption necessarily occurs during a write.
    const readBody = allowReading.promise.then(() => readAll({ readable: right.readable }));
    const readReply = readAll({ readable: left.readable });
    const forward = async () => {
      const writer = left.writable.getWriter(); await writer.write(body); await writer.close();
    };
    const backward = async () => {
      const writer = right.writable.getWriter(); await writer.write(reply); await writer.close();
    };
    await Promise.all([forward(), backward()]);
    expect(await readBody).toEqual(body); expect(await readReply).toEqual(reply);
    await Promise.all([left.closed, right.closed]);
  });
  // Immediately own rejection while fault injection and its assertions run.
  const completed = Promise.all(transfers);
  void completed.catch(() => {});
  try {
    await vi.waitFor(() => expect(altered + replayed).toBe(2));
    await vi.waitFor(() => expect(relay.occupied).toBeGreaterThan(0));
    expect(relay.interrupt()).toBeGreaterThan(0);
  } finally {
    allowReading.resolve();
  }
  await completed;
  stop.abort(); await Promise.all([a.closed, b.closed]);
  expect(relay.occupied).toBe(0);
});
