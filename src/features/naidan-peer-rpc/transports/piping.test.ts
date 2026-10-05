import { afterEach, expect, it, vi } from 'vitest';
import { openPipingRpc } from './piping';
import { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';
import { encodePeerKey } from '@/features/naidan-peer-rpc/runtime/identity';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex';
const calls = vi.hoisted(() => ({ connect: vi.fn(), pair: vi.fn() }));
vi.mock('@/features/naidan-piping-duplex', async importOriginal => ({ ...(await importOriginal<typeof import('@/features/naidan-piping-duplex')>()),
  NaidanPipingDuplexSession: { connect: calls.connect, pair: calls.pair } }));
afterEach(() => vi.clearAllMocks());
const settings = { type: 'naidan_piping_duplex' as const, serverUrl: 'https://relay.example', headers: [] };
const a: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(1) };
const b: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(2) };
it('derives opposite roles and exactly the same strong rendezvous name at both pinned peers', async () => {
  for (const [local, remote] of [[a, b], [b, a]] as const) await openPipingRpc({ settings, identity: local, peerKey: encodePeerKey({ bytes: remote.publicKey }),
    code: undefined, role: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const first = calls.connect.mock.calls[0]![0], second = calls.connect.mock.calls[1]![0];
  expect(first.code).toMatch(/^peer-[0-9a-f]{64}$/); expect(first.code).toBe(second.code); expect(first.role).not.toBe(second.role);
  expect(first.peerPublicKey ?? first.expectedPeer).toEqual(b.publicKey);
  const left = await RendezvousChannel.create({ role: 'initiator', code: first.code, origin: settings.serverUrl });
  const right = await RendezvousChannel.create({ role: 'responder', code: second.code, origin: settings.serverUrl });
  expect(left.routes.send).toBe(right.routes.receive); left.dispose(); right.dispose(); expect(calls.pair).not.toHaveBeenCalled();
});
it('does not treat relay credentials as part of the shared route namespace', async () => {
  const common = { identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, role: undefined, verifyPeer: undefined, signal: new AbortController().signal };
  await openPipingRpc({ ...common, settings });
  await openPipingRpc({ ...common, settings: { ...settings, headers: [{ name: 'Authorization', value: 'secret' }] } });
  expect(calls.connect.mock.calls[0]![0].code).toBe(calls.connect.mock.calls[1]![0].code);
});
it('keeps first-pairing codes short and requires an explicit verifier', async () => {
  await expect(openPipingRpc({ settings, identity: a, peerKey: undefined, code: 'peer-' + 'a'.repeat(64), role: 'initiator', verifyPeer: async () => true, signal: new AbortController().signal })).rejects.toThrow();
  await expect(openPipingRpc({ settings, identity: a, peerKey: undefined, code: '1234', role: 'initiator', verifyPeer: undefined, signal: new AbortController().signal })).rejects.toThrow();
  expect(calls.pair).not.toHaveBeenCalled();
});
