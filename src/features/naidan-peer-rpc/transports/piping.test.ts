import { afterEach, expect, it, vi } from 'vitest';
import { openPipingRpc } from './piping';
import { rendezvousRoom, rendezvousRoute } from '@/features/naidan-piping-duplex/rendezvous';
import { encodePeerKey } from '@/features/naidan-peer-rpc/runtime/identity';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex';
const calls = vi.hoisted(() => ({ connect: vi.fn(), pair: vi.fn() }));
vi.mock('@/features/naidan-piping-duplex', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/naidan-piping-duplex')>()),
  NaidanPipingDuplexSession: { connect: calls.connect, pair: calls.pair },
}));
afterEach(() => vi.clearAllMocks());
const settings = { type: 'naidan_piping_duplex' as const, serverUrl: 'https://relay.example', headers: [] };
const a: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(1) };
const b: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(2) };
it('derives opposite roles and exactly the same strong rendezvous name at both pinned peers', async () => {
  for (const [local, remote] of [[a, b], [b, a]] as const) await openPipingRpc({
    settings,
    identity: local,
    peerKey: encodePeerKey({ bytes: remote.publicKey }),
    code: undefined,
    verifyPeer: undefined,
    signal: new AbortController().signal,
  });
  const first = calls.connect.mock.calls[0]![0], second = calls.connect.mock.calls[1]![0];
  expect(first.code).toMatch(/^peer-[0-9a-f]{64}$/); expect(first.code).toBe(second.code); expect(first.role).not.toBe(second.role);
  expect(first.peerPublicKey ?? first.expectedPeer).toEqual(b.publicKey);
  const left = await rendezvousRoom({ code: first.code, origin: settings.serverUrl });
  const right = await rendezvousRoom({ code: second.code, origin: settings.serverUrl });
  expect(left).toEqual(right); expect(calls.pair).not.toHaveBeenCalled();
});
it('does not treat relay credentials as part of the shared route namespace', async () => {
  const common = { identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal };
  await openPipingRpc({ ...common, settings });
  await openPipingRpc({ ...common, settings: { ...settings, headers: [{ name: 'Authorization', value: 'secret' }] } });
  expect(calls.connect.mock.calls[0]![0].code).toBe(calls.connect.mock.calls[1]![0].code);
});
it('bounds first-pairing input and still requires an explicit verifier', async () => {
  await expect(openPipingRpc({ settings, identity: a, peerKey: undefined, code: 'a'.repeat(129), verifyPeer: async () => true, signal: new AbortController().signal })).rejects.toThrow();
  await expect(openPipingRpc({ settings, identity: a, peerKey: undefined, code: '1234', verifyPeer: undefined, signal: new AbortController().signal })).rejects.toThrow();
  expect(calls.pair).not.toHaveBeenCalled();
});
it('uses reciprocal discovery routes for normalized Unicode meeting codes without bypassing comparison', async () => {
  const verifyPeer = vi.fn(async () => true);
  const common = { settings, peerKey: undefined, verifyPeer, signal: new AbortController().signal };
  await openPipingRpc({ ...common, identity: a, code: '  cafe\u0301 家 🔌  ' });
  await openPipingRpc({ ...common, identity: b, code: 'café 家 🔌' });
  const first = calls.pair.mock.calls[0]![0], second = calls.pair.mock.calls[1]![0];
  expect(first.code).toMatch(/^peer-[0-9a-f]{64}$/); expect(first.code).toBe(second.code);
  expect(first.verifyPeer).toBe(verifyPeer); expect(second.verifyPeer).toBe(verifyPeer);
  const left = await rendezvousRoom({ code: first.code, origin: settings.serverUrl });
  const right = await rendezvousRoom({ code: second.code, origin: settings.serverUrl });
  expect(await rendezvousRoute({ room: left, kind: 'offer', attempts: [] })).toBe(await rendezvousRoute({ room: right, kind: 'offer', attempts: [] }));
  expect(first).not.toHaveProperty('role'); expect(second).not.toHaveProperty('role');
  expect(calls.connect).not.toHaveBeenCalled();
});
it('treats input resembling a pinned route as an ordinary meeting code requiring comparison', async () => {
  const code = 'peer-' + 'a'.repeat(64), verifyPeer = vi.fn(async () => true);
  await openPipingRpc({ settings, identity: a, peerKey: undefined, code, verifyPeer, signal: new AbortController().signal });
  expect(calls.pair).toHaveBeenCalledOnce();
  expect(calls.pair.mock.calls[0]![0].code).not.toBe(code);
  expect(calls.pair.mock.calls[0]![0].verifyPeer).toBe(verifyPeer);
  expect(calls.connect).not.toHaveBeenCalled();
});
