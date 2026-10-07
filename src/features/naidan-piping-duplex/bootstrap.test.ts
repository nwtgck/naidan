// @vitest-environment node
import { expect, it, onTestFinished, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { startPinnedConnection } from '@/features/naidan-piping-duplex/connection';
import { AttemptError } from '@/features/naidan-piping-duplex/finite';
import type { FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
type Sender = { bytes: Uint8Array; failed: ReturnType<typeof Promise.withResolvers<void>>; consumed: boolean };
type Receiver = ReturnType<typeof Promise.withResolvers<Uint8Array>>;
type Slot = { sender: Sender | undefined; receiver: Receiver | undefined };

/** Body receipt, POST EOF and local abort cleanup are deliberately separate events. */
class PausedPostRelay {
  readonly offers: Uint8Array[] = [];
  readonly posts: { owner: string; bytes: Uint8Array }[] = [];
  readonly gets: { owner: string; route: string }[] = [];
  readonly duplicates: string[] = [];
  readonly ownedPosts = new Map<string, number>();
  repairs = 0;
  drop({ bytes: _bytes }: { bytes: Uint8Array }): boolean {
    return false;
  }
  cleanupGate: Promise<void> | undefined;
  private readonly slots = new Map<string, Slot>();
  get occupied(): number {
    return this.slots.size;
  }
  private slot({ route }: { route: string }): Slot {
    let slot = this.slots.get(route);
    if (!slot) {
      slot = { sender: undefined, receiver: undefined }; this.slots.set(route, slot);
    }
    return slot;
  }
  private release({ route, slot }: { route: string; slot: Slot }): void {
    if (this.slots.get(route) === slot && !slot.sender && !slot.receiver) this.slots.delete(route);
  }
  private transfer({ slot }: { slot: Slot }): void {
    const { sender, receiver } = slot;
    if (!sender || !receiver || sender.consumed) return;
    sender.consumed = true;
    if (this.drop({ bytes: sender.bytes })) {
      const failure = new AttemptError({ kind: 'transient' });
      sender.failed.reject(failure); receiver.reject(failure);
    } else receiver.resolve(sender.bytes.slice());
  }
  endpoint({ owner }: { owner: string }): FiniteTransport {
    return {
      origin: 'https://piping.invalid',
      send: async ({ route, bytes, signal }) => {
        signal.throwIfAborted();
        expect(this.ownedPosts.get(owner) ?? 0).toBe(0);
        this.ownedPosts.set(owner, 1);
        this.posts.push({ owner, bytes: bytes.slice() });
        const slot = this.slot({ route });
        if (slot.sender) {
          this.duplicates.push(owner);
          this.ownedPosts.set(owner, 0);
          throw new AttemptError({ kind: 'waiting-sender' });
        }
        if (bytes.length === 34) this.offers.push(bytes.slice(2));
        const sender: Sender = { bytes: bytes.slice(), failed: Promise.withResolvers<void>(), consumed: false };
        slot.sender = sender;
        const abort = () => sender.failed.reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        this.transfer({ slot });
        try {
          await sender.failed.promise;
        } finally {
          signal.removeEventListener('abort', abort);
          await this.cleanupGate;
          if (slot.sender === sender) slot.sender = undefined;
          this.release({ route, slot });
          this.ownedPosts.set(owner, 0);
        }
      },
      receive: async ({ route, signal }) => {
        signal.throwIfAborted();
        this.gets.push({ owner, route });
        const slot = this.slot({ route });
        if (slot.sender?.consumed) throw new AttemptError({ kind: 'established' });
        if (slot.receiver) throw new AttemptError({ kind: 'waiting-receiver' });
        const receiver = Promise.withResolvers<Uint8Array>();
        slot.receiver = receiver;
        const abort = () => receiver.reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        this.transfer({ slot });
        try {
          return await receiver.promise;
        } finally {
          signal.removeEventListener('abort', abort);
          if (slot.receiver === receiver) slot.receiver = undefined;
          this.release({ route, slot });
        }
      },
      repair: async () => {
        this.repairs++; throw new Error('Discovery must not drain a public route');
      },
    };
  }
}

async function tasks({ relay, signal, timeoutMs, roles }: {
  relay: PausedPostRelay; signal: AbortSignal; timeoutMs: number; roles: 'automatic' | 'pinned';
}) {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const common = {
    signal,
    code: 'ABCD-EFGH',
    confirmationTimeoutMs: timeoutMs,
    completionLeaseMs: 40,
    intervalMs: 2,
    purpose: new Uint8Array([7, 4]),
    verifyPeer: undefined,
  };
  const selectedRoles = (() => {
    switch (roles) {
    case 'automatic': return { a: undefined, b: undefined };
    case 'pinned': return { a: 'initiator' as const, b: 'responder' as const };
    default: { const exhaustive: never = roles; throw new Error(String(exhaustive)); }
    }
  })();
  return promiseAllKeyed({
    a: startPinnedConnection({ ...common, role: selectedRoles.a, identity: identities.a, expectedPeer: identities.b.publicKey, endpoint: relay.endpoint({ owner: 'a' }) }),
    b: startPinnedConnection({ ...common, role: selectedRoles.b, identity: identities.b, expectedPeer: identities.a.publicKey, endpoint: relay.endpoint({ owner: 'b' }) }),
  });
}

it.each(['automatic', 'pinned'] as const)('%s pairing advances when every POST EOF is withheld', async roles => {
  const relay = new PausedPostRelay(), stop = new AbortController();
  const pair = await tasks({ relay, signal: stop.signal, timeoutMs: 500, roles });
  onTestFinished(async () => {
    stop.abort(); await Promise.allSettled([pair.a.completion, pair.b.completion]);
  });
  const keys = await promiseAllKeyed({ a: pair.a.ready, b: pair.b.ready });
  onTestFinished(() => {
    keys.a.dispose(); keys.b.dispose();
  });
  expect(keys.a.contextId).toEqual(keys.b.contextId);
  await Promise.all([pair.a.completion, pair.b.completion]);
  expect(relay.occupied).toBe(0); expect(relay.repairs).toBe(0);
  if (roles === 'automatic') expect(relay.duplicates).toHaveLength(1);
});

it('a lost ACK is replayed with the same selection before Noise proceeds', async () => {
  const relay = new PausedPostRelay(), stop = new AbortController();
  let lost: Uint8Array | undefined;
  relay.drop = ({ bytes }) => {
    if (!lost && bytes.length === 99 && bytes[33] === 2) {
      lost = bytes.slice(); return true;
    }
    return false;
  };
  const pair = await tasks({ relay, signal: stop.signal, timeoutMs: 500, roles: 'automatic' });
  onTestFinished(async () => {
    stop.abort(); await Promise.allSettled([pair.a.completion, pair.b.completion]);
  });
  const keys = await promiseAllKeyed({ a: pair.a.ready, b: pair.b.ready });
  onTestFinished(() => {
    keys.a.dispose(); keys.b.dispose();
  });
  expect(lost).toBeDefined();
  const acknowledgements = relay.posts.filter(({ bytes }) => bytes.length === 99 && bytes[33] === 2);
  expect(acknowledgements.length).toBeGreaterThan(1);
  expect(acknowledgements.every(({ bytes }) => bytes.every((value, index) => value === lost?.[index]))).toBe(true);
  expect(keys.a.contextId).toEqual(keys.b.contextId);
});

it('permanent ACK loss retires requests and starts fresh attempts without producing keys', async () => {
  const relay = new PausedPostRelay(), stop = new AbortController();
  relay.drop = ({ bytes }) => bytes.length === 99 && bytes[33] === 2;
  const pair = await tasks({ relay, signal: stop.signal, timeoutMs: 40, roles: 'automatic' });
  onTestFinished(async () => {
    stop.abort(); await Promise.allSettled([pair.a.completion, pair.b.completion]);
  });
  let ready = 0;
  void pair.a.ready.then(() => {
    ready++;
  }, () => {}); void pair.b.ready.then(() => {
    ready++;
  }, () => {});
  await vi.waitFor(() => expect(new Set(relay.offers.map(bytes => Array.from(bytes).join(','))).size).toBeGreaterThan(1));
  expect(ready).toBe(0);
  stop.abort(); await Promise.allSettled([pair.a.completion, pair.b.completion]);
  expect(relay.occupied).toBe(0); expect([...relay.ownedPosts.values()].every(count => count === 0)).toBe(true);
});

it('candidate selection joins a cancelled OFFER before starting SELECT', async () => {
  const relay = new PausedPostRelay(), stop = new AbortController(), release = Promise.withResolvers<void>();
  relay.cleanupGate = release.promise;
  const pair = await tasks({ relay, signal: stop.signal, timeoutMs: 500, roles: 'automatic' });
  onTestFinished(async () => {
    release.resolve(); stop.abort(); await Promise.allSettled([pair.a.completion, pair.b.completion]);
  });
  await vi.waitFor(() => expect(relay.posts.some(({ bytes }) => bytes.length === 66)).toBe(true));
  expect(relay.posts.some(({ bytes }) => bytes.length === 99)).toBe(false);
  release.resolve();
  const keys = await promiseAllKeyed({ a: pair.a.ready, b: pair.b.ready });
  onTestFinished(() => {
    keys.a.dispose(); keys.b.dispose();
  });
  expect(keys.a.contextId).toEqual(keys.b.contextId);
});

it('waiting for an absent peer outlives the automatic candidate confirmation budget', async () => {
  const relay = new PausedPostRelay(), stop = new AbortController();
  const identity = await createNaidanPipingIdentity(), peer = await createNaidanPipingIdentity();
  const task = await startPinnedConnection({
    endpoint: relay.endpoint({ owner: 'alone' }),
    role: undefined,
    code: 'ABCD-EFGH',
    identity,
    expectedPeer: peer.publicKey,
    verifyPeer: undefined,
    purpose: new Uint8Array([1]),
    signal: stop.signal,
    confirmationTimeoutMs: 10,
    completionLeaseMs: 40,
    intervalMs: 2,
  });
  onTestFinished(async () => {
    stop.abort(); await task.completion.catch(() => {});
  });
  let settled = false; void task.ready.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(settled).toBe(false); expect(relay.offers).toHaveLength(1);
  stop.abort(); await task.completion.catch(() => {}); expect(relay.occupied).toBe(0);
});

it('restarts automatic offering after consuming its own delayed server-side OFFER', async () => {
  const relay = new PausedPostRelay(), stop = new AbortController();
  const aSecond = Promise.withResolvers<void>(), bDuplicate = Promise.withResolvers<void>(), selfConsumed = Promise.withResolvers<void>();
  let oldOffer: Uint8Array | undefined, aOffers = 0, bOffers = 0;
  const abortWait = ({ signal }: { signal: AbortSignal }): Promise<never> => {
    signal.throwIfAborted();
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const endpoint = ({ owner }: { owner: 'a' | 'b' }): FiniteTransport => {
    const base = relay.endpoint({ owner }); let gets = 0;
    return {
      ...base,
      async send(args) {
      if (args.bytes.length === 34) {
        if (owner === 'a') {
          aOffers++;
          if (aOffers === 1) {
            oldOffer = args.bytes.slice();
            // A failed local request leaves its old body available at the server.
            await new Promise(resolve => setTimeout(resolve, 5));
            throw new AttemptError({ kind: 'transient' });
          }
          if (aOffers === 2) {
            aSecond.resolve(); throw new AttemptError({ kind: 'waiting-sender' });
          }
        } else if (++bOffers === 1) {
          bDuplicate.resolve(); throw new AttemptError({ kind: 'waiting-sender' });
        }
      }
      return base.send(args);
    },
      async receive(args) {
      if (++gets === 1) {
        try {
          return await abortWait({ signal: args.signal });
        } finally {
          // Both peers see the retained sender before either enters GET mode.
          await (owner === 'a' ? bDuplicate.promise : selfConsumed.promise);
        }
      }
      if (owner === 'a' && oldOffer) {
        const bytes = oldOffer; oldOffer = undefined; selfConsumed.resolve();
        return bytes;
      }
      return base.receive(args);
    },
    };
  };
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const common = {
    signal: stop.signal,
    role: undefined,
    code: 'ABCD-EFGH',
    confirmationTimeoutMs: 500,
    completionLeaseMs: 40,
    intervalMs: 2,
    purpose: new Uint8Array([1]),
    verifyPeer: undefined,
  };
  const a = await startPinnedConnection({ ...common, endpoint: endpoint({ owner: 'a' }), identity: identities.a, expectedPeer: identities.b.publicKey });
  onTestFinished(async () => {
    stop.abort(); bDuplicate.resolve(); selfConsumed.resolve(); await a.completion.catch(() => {});
  });
  await aSecond.promise;
  const b = await startPinnedConnection({ ...common, endpoint: endpoint({ owner: 'b' }), identity: identities.b, expectedPeer: identities.a.publicKey });
  onTestFinished(async () => {
    stop.abort(); await b.completion.catch(() => {});
  });
  const keys = await promiseAllKeyed({ a: a.ready, b: b.ready });
  onTestFinished(() => {
    keys.a.dispose(); keys.b.dispose();
  });
  expect(aOffers).toBeGreaterThanOrEqual(3);
  expect(keys.a.contextId).toEqual(keys.b.contextId); expect(relay.repairs).toBe(0);
});
