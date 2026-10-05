// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

it('managed API owns both directions, large writes, half-close, and complete cleanup', async () => {
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

it('idle lifetime cancellation settles incoming and outstanding streams without waiting for new I/O', async () => {
  const { relay, stop } = setup();
  const { a, b } = await sessions({ signal: stop.signal });
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const pending = incoming.next();
  const rejected = expect(pending).rejects.toThrow();
  stop.abort(); await rejected;
  await Promise.all([a.closed, b.closed]); expect(relay.occupied).toBe(0);
});

it('cancellation during discovery rejects connection and leaves no relay requests', async () => {
  const { relay, stop } = setup(), identity = await createNaidanPipingIdentity();
  const peer = await createNaidanPipingIdentity();
  const pending = NaidanPipingDuplexSession.connect({ piping: options, code: 'ABCD-EFGH', role: 'initiator', identity,
    expectedPeer: peer.publicKey, signal: stop.signal });
  const rejected = expect(pending).rejects.toBeDefined();
  stop.abort(); await rejected; expect(relay.occupied).toBe(0);
});

it('unknown pins cannot be replaced with code-only authentication', async () => {
  const { relay, stop } = setup(), identity = await createNaidanPipingIdentity();
  await expect(NaidanPipingDuplexSession.connect({ piping: options, code: 'ABCD-EFGH', role: 'initiator', identity,
    expectedPeer: new Uint8Array(), signal: stop.signal })).rejects.toThrow();
  expect(relay.occupied).toBe(0);
});

it('configuration is validated before opening network requests', async () => {
  const { relay, stop } = setup();
  const identity = await createNaidanPipingIdentity();
  for (const baseUrl of ['http://evil.invalid', 'https://user:pass@relay.invalid/', 'https://relay.invalid/?secret=1']) {
    await expect(NaidanPipingDuplexSession.connect({ piping: { ...options, baseUrl }, code: 'ABCD-EFGH', role: 'initiator',
      identity, expectedPeer: identity.publicKey, signal: stop.signal })).rejects.toThrow();
  }
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); expect(relay.occupied).toBe(0);
});

it('different upper transport profiles are bound into authentication and cannot both become ready', async () => {
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


it('a successful POST without peer acceptance leaves the write pending', async () => {
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

it('concurrent streams recover from relay state loss, corrupt bytes, and replayed ciphertext without a server', async () => {
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

async function pinnedTasks({ signal, activeTimeoutMs, completionLeaseMs }: {
  signal: AbortSignal; activeTimeoutMs: number; completionLeaseMs: number;
}) {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const endpoint = () => new FiniteEndpoint({ baseUrl: options.baseUrl, policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 20 });
  const common = { code: 'ABCD-EFGH', signal, activeTimeoutMs, completionLeaseMs, intervalMs: 2, purpose: new Uint8Array([1, 4]) };
  return promiseAllKeyed({
    a: startPinnedConnection({ ...common, role: 'initiator', identity: identities.a, expectedPeer: identities.b.publicKey, endpoint: endpoint() }),
    b: startPinnedConnection({ ...common, role: 'responder', identity: identities.b, expectedPeer: identities.a.publicKey, endpoint: endpoint() }),
  });
}

/** Preserve the valid cumulative prefix rather than replacing a missing flight with corrupt bytes. */
function withholdFinalResponderFlight({ bytes }: { bytes: Uint8Array }): Uint8Array {
  if (bytes[0] !== 1 || bytes[1] !== 2 || bytes[66] !== 4) return bytes;
  let end = 67;
  for (let index = 0; index < 3; index++) end += 4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(end + 2, false);
  const prefix = bytes.slice(0, end); prefix[66] = 3;
  return prefix;
}

it('key readiness and finite handshake cleanup are distinct and cleanup does not dispose returned keys', async () => {
  const { relay, stop } = setup(), tasks = await pinnedTasks({ signal: stop.signal, activeTimeoutMs: 2000, completionLeaseMs: 80 });
  const keys = await promiseAllKeyed({ a: tasks.a.ready, b: tasks.b.ready });
  let completed = false; void tasks.a.completion.then(() => {
    completed = true;
  }, () => {});
  try {
    expect(completed).toBe(false);
    await Promise.all([tasks.a.completion, tasks.b.completion]);
    expect(relay.occupied).toBe(0);
    const context = new Uint8Array([5]);
    const left = keys.a.createDomain({ label: 'test/after-cleanup', context }), right = keys.b.createDomain({ label: 'test/after-cleanup', context });
    expect(await left.route({ direction: 1 })).toBe(await right.route({ direction: 1 }));
  } finally {
    stop.abort(); keys.a.dispose(); keys.b.dispose(); await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
  }
});

it('a lost final key-confirmation flight is repeated without restarting the handshake', async () => {
  const { relay, stop } = setup(); let lost = 0;
  relay.transformReplies({ transform: ({ bytes }) => {
    if (lost || bytes[0] !== 1 || bytes[1] !== 2 || bytes[66] !== 4) return bytes;
    lost++; return withholdFinalResponderFlight({ bytes });
  } });
  const tasks = await pinnedTasks({ signal: stop.signal, activeTimeoutMs: 2000, completionLeaseMs: 100 });
  const keys = await promiseAllKeyed({ a: tasks.a.ready, b: tasks.b.ready });
  try {
    expect(lost).toBe(1); expect(keys.a.contextId).toEqual(keys.b.contextId);
    await Promise.all([tasks.a.completion, tasks.b.completion]); expect(relay.occupied).toBe(0);
  } finally {
    stop.abort(); keys.a.dispose(); keys.b.dispose(); await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
  }
});

it('permanent final-flight loss cannot be reported as mutual connection success', async () => {
  const { relay, stop } = setup(); let lost = 0;
  relay.transformReplies({ transform: ({ bytes }) => {
    const prefix = withholdFinalResponderFlight({ bytes });
    if (prefix !== bytes) lost++;
    return prefix;
  } });
  const tasks = await pinnedTasks({ signal: stop.signal, activeTimeoutMs: 600, completionLeaseMs: 100 });
  try {
    const results = await Promise.allSettled([tasks.a.ready, tasks.b.ready]);
    expect(lost).toBeGreaterThan(0);
    expect(results[0]!.status).toBe('rejected'); expect(results[1]!.status).toBe('fulfilled');
    for (const result of results) if (result.status === 'fulfilled') result.value.dispose();
    const completed = await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
    expect(completed[0]!.status).toBe('rejected'); expect(completed[1]!.status).toBe('fulfilled');
    expect(relay.occupied).toBe(0);
  } finally {
    stop.abort(); await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
  }
});

it('cancelling handshake retention cleans all HTTP requests but leaves key ownership with its caller', async () => {
  const { relay, stop } = setup(), tasks = await pinnedTasks({ signal: stop.signal, activeTimeoutMs: 2000, completionLeaseMs: 10000 });
  const keys = await promiseAllKeyed({ a: tasks.a.ready, b: tasks.b.ready });
  try {
    stop.abort(new Error('Cancel handshake retention'));
    const completed = await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
    expect(completed.every(result => result.status === 'rejected')).toBe(true); expect(relay.occupied).toBe(0);
    const domain = keys.a.createDomain({ label: 'test/retained-key-owner', context: new Uint8Array() });
    expect(await domain.route({ direction: 1 })).not.toHaveLength(0);
  } finally {
    stop.abort(); keys.a.dispose(); keys.b.dispose(); await Promise.allSettled([tasks.a.completion, tasks.b.completion]);
  }
});

it('managed configuration and pins are owned before asynchronous connection work', async () => {
  const { relay, stop } = setup(), identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const copiedOptions = { ...options, pacing: { ...options.pacing } }, pin = identities.b.publicKey.slice();
  const left = NaidanPipingDuplexSession.connect({ piping: copiedOptions, code: 'ABCD-EFGH', role: 'initiator', identity: identities.a,
    expectedPeer: pin, signal: stop.signal });
  copiedOptions.baseUrl = 'https://other.invalid'; copiedOptions.pacing.minimumMs = 0; pin.fill(0);
  const right = NaidanPipingDuplexSession.connect({ piping: options, code: 'ABCD-EFGH', role: 'responder', identity: identities.b,
    expectedPeer: identities.a.publicKey, signal: stop.signal });
  const { a, b } = await promiseAllKeyed({ a: left, b: right });
  try {
    const identity = a.peerIdentity; expect(identity).toEqual(identities.b.publicKey); identity.fill(0);
    expect(a.peerIdentity).toEqual(identities.b.publicKey);
    a.abort({ reason: 'Caller stopped' }); await a.closed;
  } finally {
    stop.abort(); await Promise.all([a.closed, b.closed]);
  }
  expect(relay.occupied).toBe(0);
});

it('the public pairing API uses a short number, waits for both approvals, and keeps the established session until stopped', async () => {
  const { relay, stop } = setup();
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const shownA = Promise.withResolvers<Uint8Array>(), shownB = Promise.withResolvers<Uint8Array>();
  const approveA = Promise.withResolvers<boolean>(), approveB = Promise.withResolvers<boolean>();
  const settings = { ...options, connectionTimeoutMs: undefined, handshakeRetentionMs: undefined };
  const first = NaidanPipingDuplexSession.pair({ piping: settings, code: '0017', role: 'initiator', identity: identities.a, signal: stop.signal,
    verifyPeer: ({ comparison }) => {
      shownA.resolve(comparison); return approveA.promise;
    } });
  const second = NaidanPipingDuplexSession.pair({ piping: settings, code: '0017', role: 'responder', identity: identities.b, signal: stop.signal,
    verifyPeer: ({ comparison }) => {
      shownB.resolve(comparison); return approveB.promise;
    } });
  const comparisons = await promiseAllKeyed({ a: shownA.promise, b: shownB.promise }); expect(comparisons.a).toEqual(comparisons.b);
  let ready = 0; void first.then(() => {
    ready++;
  }); void second.then(() => {
    ready++;
  });
  approveA.resolve(true); await new Promise(resolve => setTimeout(resolve, 15)); expect(ready).toBe(0);
  approveB.resolve(true); const sessions = await promiseAllKeyed({ a: first, b: second });
  expect(sessions.a.peerIdentity).toEqual(identities.b.publicKey);
  const incoming = sessions.b.incomingStreams[Symbol.asyncIterator]();
  const left = await sessions.a.openStream({ signal: undefined }), right = await incoming.next();
  if (right.done) throw new Error('Missing peer stream');
  relay.interrupt(); const writer = left.writable.getWriter();
  const reading = readAll({ readable: right.value.readable }); await writer.write(new Uint8Array([7, 1, 9])); await writer.close();
  expect(await reading).toEqual(new Uint8Array([7, 1, 9])); await right.value.writable.close();
  await Promise.all([left.closed, right.value.closed]); stop.abort(); await Promise.all([sessions.a.closed, sessions.b.closed]);
  expect(relay.occupied).toBe(0);
});
it('a pairing cancelled while waiting for user comparison never returns a usable late connection', async () => {
  const { relay, stop } = setup();
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const shown = Promise.withResolvers<void>(), gate = Promise.withResolvers<boolean>();
  const settings = { ...options, connectionTimeoutMs: undefined, handshakeRetentionMs: undefined };
  const a = NaidanPipingDuplexSession.pair({ piping: settings, code: '0023', role: 'initiator', identity: identities.a,
    signal: stop.signal, verifyPeer: () => {
      shown.resolve(); return gate.promise;
    } });
  const b = NaidanPipingDuplexSession.pair({ piping: settings, code: '0023', role: 'responder', identity: identities.b,
    signal: stop.signal, verifyPeer: async () => true });
  const failures = [expect(a).rejects.toBeDefined(), expect(b).rejects.toBeDefined()];
  await shown.promise; stop.abort(); gate.resolve(true); await Promise.all(failures); expect(relay.occupied).toBe(0);
});
