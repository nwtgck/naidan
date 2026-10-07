// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { establishNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import { keyPair, mailbox, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

async function rejectedHandshake({ failure }: { failure: 'pin' | 'binding' | 'final' }): Promise<{
  left: PromiseSettledResult<Awaited<ReturnType<typeof establishNaidanPipingKeys>>>;
  right: PromiseSettledResult<Awaited<ReturnType<typeof establishNaidanPipingKeys>>>;
  sendsFromInitiator: number;
}> {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity(), other: createNaidanPipingIdentity() });
  const toA = mailbox(), toB = mailbox(), stop = new AbortController();
  let sendsFromInitiator = 0, responderFlights = 0;
  const left = establishNaidanPipingKeys({
    role: 'initiator',
    identity: identities.a,
    expectedPeer: failure === 'pin' ? identities.other.publicKey : identities.b.publicKey,
    binding: new Uint8Array(32),
    signal: stop.signal,
    channel: {
      receive: toA.receive,
      send: async ({ bytes }) => {
      sendsFromInitiator++; await toB.send({ bytes });
    },
    },
  });
  const right = establishNaidanPipingKeys({
    role: 'responder',
    identity: identities.b,
    expectedPeer: identities.a.publicKey,
    binding: new Uint8Array(32).fill(failure === 'binding' ? 1 : 0),
    signal: stop.signal,
    channel: {
      receive: toB.receive,
      send: async ({ bytes }) => {
      responderFlights++;
      const owned = bytes.slice();
      if (failure === 'final' && responderFlights === 4) owned[owned.length - 1]! ^= 1;
      await toA.send({ bytes: owned });
    },
    },
  });
  // The failing side wakes the other; no test waits for an unrelated timeout to pass.
  void left.catch(error => stop.abort(error)); void right.catch(error => stop.abort(error));
  const timer = setTimeout(() => stop.abort(new Error('Test key exchange did not terminate')), 5000);
  try {
    const results = await promiseAllKeyed({ left: Promise.allSettled([left]), right: Promise.allSettled([right]) });
    const l = results.left[0]!, r = results.right[0]!;
    if (l.status === 'fulfilled') l.value.dispose();
    if (r.status === 'fulfilled') r.value.dispose();
    return { left: l, right: r, sendsFromInitiator };
  } finally {
    clearTimeout(timer); stop.abort();
  }
}

it('pin mismatch aborts before the initiator discloses its long-term public identity', async () => {
  const result = await rejectedHandshake({ failure: 'pin' });
  expect(result.left.status).toBe('rejected'); expect(result.right.status).toBe('rejected');
  expect(result.sendsFromInitiator).toBe(1);
  if (result.left.status === 'rejected') expect(String(result.left.reason)).toContain('identity mismatch');
});

it('different rendezvous bindings never establish compatible keys', async () => {
  const result = await rejectedHandshake({ failure: 'binding' });
  expect(result.left.status).toBe('rejected'); expect(result.right.status).toBe('rejected');
});

it('a modified final confirmation cannot publish a key context to its receiver', async () => {
  const result = await rejectedHandshake({ failure: 'final' });
  expect(result.left.status).toBe('rejected');
  // The other endpoint may have received our confirmation already; no mutual-knowledge claim.
});

it('pre-cancelled key establishment sends no handshake message', async () => {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const stop = new AbortController(), reason = new Error('Do not start'); stop.abort(reason);
  const send = vi.fn(), receive = vi.fn();
  await expect(establishNaidanPipingKeys({
    role: 'initiator',
    identity: identities.a,
    expectedPeer: identities.b.publicKey,
    binding: new Uint8Array(32),
    channel: { send, receive },
    signal: stop.signal,
  })).rejects.toBe(reason);
  expect(send).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
});

it('missing pin or binding lengths fail without network or handshake-channel use', async () => {
  const identity = await createNaidanPipingIdentity(), send = vi.fn(), receive = vi.fn();
  for (const length of [0, 31, 33]) {
    await expect(establishNaidanPipingKeys({
      role: 'initiator',
      identity,
      expectedPeer: new Uint8Array(length),
      binding: new Uint8Array(32),
      channel: { send, receive },
      signal: new AbortController().signal,
    })).rejects.toThrow();
    await expect(establishNaidanPipingKeys({
      role: 'initiator',
      identity,
      expectedPeer: identity.publicKey,
      binding: new Uint8Array(length),
      channel: { send, receive },
      signal: new AbortController().signal,
    })).rejects.toThrow();
  }
  expect(send).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
});

it('directional keys agree for reciprocal permissions but not for direction, epoch or application context', async () => {
  const keys = await keyPair(), context = new Uint8Array([9]);
  const left = keys.a.createDomain({ label: 'test/keys', context }), right = keys.b.createDomain({ label: 'test/keys', context });
  const tx = await left.aead({ direction: 1, epoch: 0n, usage: 'encrypt' });
  const rx = await right.aead({ direction: 1, epoch: 0n, usage: 'decrypt' });
  const params = { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 };
  const ciphertext = await crypto.subtle.encrypt(params, tx, new Uint8Array([5, 8]));
  expect(new Uint8Array(await crypto.subtle.decrypt(params, rx, ciphertext))).toEqual(new Uint8Array([5, 8]));
  const different = keys.b.createDomain({ label: 'test/keys', context: new Uint8Array([8]) });
  for (const key of [await right.aead({ direction: 2, epoch: 0n, usage: 'decrypt' }),
    await right.aead({ direction: 1, epoch: 1n, usage: 'decrypt' }),
    await different.aead({ direction: 1, epoch: 0n, usage: 'decrypt' })]) {
    await expect(crypto.subtle.decrypt(params, key, ciphertext)).rejects.toThrow();
  }
  expect(tx.extractable).toBe(false); expect(rx.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('raw', tx)).rejects.toThrow();
  expect(await left.route({ direction: 1 })).toBe(await right.route({ direction: 1 }));
  expect(await left.route({ direction: 1 })).not.toBe(await right.route({ direction: 2 }));
});

it.each(['', 'UPPER', 'a b', '/leading', 'é', '\ud800', '\ud801', 'x'.repeat(65)])('domain label %j is rejected before consuming any valid scope', async label => {
  const { a } = await keyPair();
  expect(() => a.createDomain({ label, context: new Uint8Array() })).toThrow('label');
  expect(() => a.createDomain({ label: 'valid', context: new Uint8Array() })).not.toThrow();
});

it('domain context is copied and duplicate byte scopes cannot acquire fresh security state', async () => {
  const { a, b } = await keyPair(), context = new Uint8Array([9, 4]);
  const first = a.createDomain({ label: 'test/context', context }); context.fill(8);
  const peer = b.createDomain({ label: 'test/context', context: new Uint8Array([9, 4]) });
  expect(await first.route({ direction: 1 })).toBe(await peer.route({ direction: 1 }));
  expect(() => a.createDomain({ label: 'test/context', context: new Uint8Array([9, 4]) })).toThrow('consumed');
  const id = a.contextId, identity = a.peerIdentity; id.fill(0); identity.fill(0);
  expect(a.contextId).not.toEqual(id); expect(a.peerIdentity).not.toEqual(identity);
});

it('key-domain capacity and context allocation are bounded', async () => {
  const { a } = await keyPair();
  expect(() => a.createDomain({ label: 'test/oversized', context: new Uint8Array(4097) })).toThrow('limit');
  for (let index = 0; index < 64; index++) a.createDomain({ label: `test/${index}`, context: new Uint8Array() });
  expect(() => a.createDomain({ label: 'test/overflow', context: new Uint8Array() })).toThrow('capacity');
});

it('disposal during an asynchronous route or key derivation rejects the result', async () => {
  const { a, b } = await keyPair();
  const left = a.createDomain({ label: 'test/dispose', context: new Uint8Array() });
  const right = b.createDomain({ label: 'test/dispose', context: new Uint8Array() });
  const route = left.route({ direction: 1 }), key = right.aead({ direction: 1, epoch: 0n, usage: 'decrypt' });
  const rejectedRoute = expect(route).rejects.toThrow('disposed');
  const rejectedKey = expect(key).rejects.toThrow('disposed');
  a.dispose(); b.dispose();
  await Promise.all([rejectedRoute, rejectedKey]);
  expect(() => a.createDomain({ label: 'new', context: new Uint8Array() })).toThrow('disposed');
  expect(() => left.claimRecordOwner({ direction: 1, usage: 'encrypt', context: a.contextId })).toThrow('disposed');
});
