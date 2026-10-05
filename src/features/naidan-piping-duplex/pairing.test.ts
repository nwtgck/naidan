// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { Pulse } from '@/features/naidan-piping-duplex/bytes';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingHandshakeChannel, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';

const stops = new Set<AbortController>();
afterEach(() => {
  for (const stop of stops) stop.abort(); stops.clear(); vi.restoreAllMocks();
});
function channel(): NaidanPipingHandshakeChannel {
  const messages: Uint8Array[] = [], change = new Pulse();
  return { async send({ bytes }) {
    messages.push(bytes.slice()); change.fire();
  }, async receive({ signal }) {
    for (;;) {
      const revision = change.revision; signal.throwIfAborted(); const bytes = messages.shift(); if (bytes) return bytes; await change.wait({ revision, signal });
    }
  } };
}
async function start({ verifyA, verifyB, known, corruptStatus }: {
  verifyA: NaidanPipingPeerVerifier | undefined; verifyB: NaidanPipingPeerVerifier | undefined;
  known: boolean; corruptStatus: boolean;
}) {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const ab = channel(), ba = channel(), stop = new AbortController(); stops.add(stop);
  const binding = new Uint8Array(32); let bFlights = 0;
  const bSend: NaidanPipingHandshakeChannel['send'] = async ({ bytes }) => {
    bFlights++; if (corruptStatus && bFlights === 2) {
      bytes = bytes.slice(); bytes[bytes.length - 1]! ^= 1;
    } await ba.send({ bytes });
  };
  const a = establishVerifiedNaidanPipingKeys({ role: 'initiator', identity: identities.a, expectedPeer: known ? identities.b.publicKey : undefined,
    verifyPeer: verifyA, binding, channel: { send: ab.send, receive: ba.receive }, signal: stop.signal });
  const b = establishVerifiedNaidanPipingKeys({ role: 'responder', identity: identities.b, expectedPeer: known ? identities.a.publicKey : undefined,
    verifyPeer: verifyB, binding, channel: { send: bSend, receive: ab.receive }, signal: stop.signal });
  void a.catch(error => stop.abort(error)); void b.catch(error => stop.abort(error));
  return { a, b, identities, stop };
}
it('both peers compare the complete binding and neither can export keys before both explicit approvals', async () => {
  const pendingA = Promise.withResolvers<boolean>(), pendingB = Promise.withResolvers<boolean>();
  const reachedA = Promise.withResolvers<Parameters<NaidanPipingPeerVerifier>[0]>(), reachedB = Promise.withResolvers<Parameters<NaidanPipingPeerVerifier>[0]>();
  const pair = await start({ known: false, corruptStatus: false,
    verifyA: data => {
      reachedA.resolve(data); return pendingA.promise;
    }, verifyB: data => {
      reachedB.resolve(data); return pendingB.promise;
    } });
  const shown = await promiseAllKeyed({ a: reachedA.promise, b: reachedB.promise });
  expect(shown.a.comparison.byteLength).toBe(32); expect(shown.a.comparison).toEqual(shown.b.comparison);
  expect(shown.a.peerIdentity).toEqual(pair.identities.b.publicKey); expect(shown.b.peerIdentity).toEqual(pair.identities.a.publicKey);
  let released = 0; void pair.a.then(() => {
    released++;
  }); void pair.b.then(() => {
    released++;
  });
  pendingA.resolve(true); await new Promise(resolve => setTimeout(resolve, 10)); expect(released).toBe(0);
  pendingB.resolve(true); const keys = await promiseAllKeyed({ a: pair.a, b: pair.b });
  expect(keys.a.contextId).toEqual(keys.b.contextId); keys.a.dispose(); keys.b.dispose();
});
it('rejecting a comparison prevents either peer from returning a usable context', async () => {
  const pair = await start({ known: false, corruptStatus: false, verifyA: async () => false, verifyB: async () => true });
  const settled = await Promise.allSettled([pair.a, pair.b]); expect(settled.every(value => value.status === 'rejected')).toBe(true);
});
it('a late acceptance of an obsolete dialog cannot resume a cancelled key exchange', async () => {
  const gate = Promise.withResolvers<boolean>(), shown = Promise.withResolvers<void>();
  const pair = await start({ known: false, corruptStatus: false, verifyA: () => {
    shown.resolve(); return gate.promise;
  }, verifyB: async () => true });
  await shown.promise; pair.stop.abort(new Error('Dialog closed'));
  await expect(pair.a).rejects.toThrow('Dialog closed'); gate.resolve(true); await expect(pair.b).rejects.toThrow();
});
it('the verification callback receives copies and cannot rewrite the authenticated identity or binding', async () => {
  const verify: NaidanPipingPeerVerifier = async ({ peerIdentity, comparison }) => {
    peerIdentity.fill(0); comparison.fill(0); return true;
  };
  const pair = await start({ known: false, corruptStatus: false, verifyA: verify, verifyB: verify });
  const keys = await promiseAllKeyed({ a: pair.a, b: pair.b });
  expect(keys.a.peerIdentity).toEqual(pair.identities.b.publicKey); expect(keys.b.peerIdentity).toEqual(pair.identities.a.publicKey);
  expect(keys.a.contextId).toEqual(keys.b.contextId); keys.a.dispose(); keys.b.dispose();
});
it('an authenticated-status modification fails before requesting human approval', async () => {
  const verifyA = vi.fn(async () => true), verifyB = vi.fn(async () => true);
  const pair = await start({ known: false, corruptStatus: true, verifyA, verifyB });
  await expect(pair.a).rejects.toThrow(); await expect(pair.b).rejects.toThrow(); expect(verifyA).not.toHaveBeenCalled();
});
it('different handshake transcripts cannot produce the same displayed full comparison text', async () => {
  const shown: Uint8Array[] = [];
  for (let n = 0; n < 2; n++) {
    const pair = await start({ known: false, corruptStatus: false, verifyA: async ({ comparison }) => {
      shown.push(comparison); return true;
    }, verifyB: async () => true });
    const keys = await promiseAllKeyed({ a: pair.a, b: pair.b }); keys.a.dispose(); keys.b.dispose();
  }
  expect(shown[0]).not.toEqual(shown[1]);
});
it('two pinned peers do not need to display or approve another comparison', async () => {
  const verify = vi.fn(async () => {
    throw new Error('Known peer must not prompt');
  });
  const pair = await start({ known: true, corruptStatus: false, verifyA: verify, verifyB: verify });
  const keys = await promiseAllKeyed({ a: pair.a, b: pair.b }); expect(verify).not.toHaveBeenCalled(); keys.a.dispose(); keys.b.dispose();
});
it('unknown-peer establishment without a verifier fails closed', async () => {
  const identity = await createNaidanPipingIdentity();
  await expect(establishVerifiedNaidanPipingKeys({ role: 'initiator', identity, expectedPeer: undefined, verifyPeer: undefined,
    binding: new Uint8Array(32), channel: channel(), signal: new AbortController().signal })).rejects.toThrow();
});
it('short numeric rendezvous preserves leading zeros and does not act as the authentication value', async () => {
  const a = await RendezvousChannel.create({ role: 'initiator', code: '0042', origin: 'https://relay.invalid' });
  const b = await RendezvousChannel.create({ role: 'responder', code: '0042', origin: 'https://relay.invalid' });
  expect(a.routes.send).toBe(b.routes.receive); expect(a.routes.receive).toBe(b.routes.send);
  const different = await RendezvousChannel.create({ role: 'responder', code: '0420', origin: 'https://relay.invalid' });
  expect(a.routes.send).not.toBe(different.routes.receive);
  for (const code of ['123', '123456789', '００４２', ' 0042', '00 42']) await expect(RendezvousChannel.create({ role: 'initiator', code, origin: 'https://relay.invalid' })).rejects.toThrow();
  a.dispose(); b.dispose(); different.dispose();
});
