// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/features/naidan-piping-duplex';
import * as peerKeys from '@/features/naidan-piping-duplex/peer-key';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in unit test'));
});

afterEach(() => vi.restoreAllMocks());

it('the public duplex facade has a functional name and keeps key-only access separate', () => {
  expect(Object.keys(api).sort()).toEqual([
    'NaidanPipingDuplexSession',
    'HandshakeResponseUnconfirmedError',
    'PipingRetirementError',
    'RecordExhaustedError',
    'ResponseUnconfirmedError',
    'TEST_ONLY',
    'createNaidanPipingCode',
    'createNaidanPipingIdentity',
    'establishNaidanPipingKeys',
  ].sort());
  expect(api.NaidanPipingDuplexSession.prototype).not.toHaveProperty('confirmResponse');
  expect(api.NaidanPipingDuplexSession).toHaveProperty('connectPinned');
  expect(api.NaidanPipingDuplexSession).toHaveProperty('pair');
  expect(api).not.toHaveProperty('NaidanPipingPeerEndpoint');
  expect(api.NaidanPipingDuplexSession.name).toBe('NaidanPipingDuplexSession');
  expect(Object.keys(peerKeys).sort()).toEqual([
    'TEST_ONLY', 'createNaidanPipingIdentity', 'establishNaidanPipingKeys',
  ].sort());
  expect(api.establishNaidanPipingKeys).toBe(peerKeys.establishNaidanPipingKeys);
  expect(api.createNaidanPipingIdentity).toBe(peerKeys.createNaidanPipingIdentity);
});

it.each(['http://example.com', 'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?n=2', 'https://relay.example/#private'])('rejects an unsafe relay origin before opening network requests (%s)', async baseUrl => {
  const [identity, other] = await Promise.all([api.createNaidanPipingIdentity(), api.createNaidanPipingIdentity()]);
  await expect(api.NaidanPipingDuplexSession.connectPinned({
    piping: { baseUrl, policy: 'https-only', requestTimeoutMs: 1000, handshakeResponseTimeoutMs: 1000 },
    identity,
    expectedPeer: other.publicKey,
    signal: new AbortController().signal,
  })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects a mismatched local identity before publishing its fixed route', async () => {
  const [identity, other] = await Promise.all([api.createNaidanPipingIdentity(), api.createNaidanPipingIdentity()]);
  await expect(api.NaidanPipingDuplexSession.connectPinned({
    piping: { baseUrl: 'https://relay.example', policy: 'https-only', requestTimeoutMs: 1000, handshakeResponseTimeoutMs: 1000 },
    identity: { privateKey: identity.privateKey, publicKey: other.publicKey },
    expectedPeer: identity.publicKey,
    signal: new AbortController().signal,
  })).rejects.toThrow('Local identity key pair mismatch');
  expect(fetch).not.toHaveBeenCalled();
});

it('does not begin authentication or network work after parent cancellation', async () => {
  const identity = await api.createNaidanPipingIdentity(), stop = new AbortController(), reason = new Error('already stopped'); stop.abort(reason);
  await expect(api.NaidanPipingDuplexSession.connectPinned({
    piping: { baseUrl: 'https://relay.example', policy: 'https-only', requestTimeoutMs: 1000, handshakeResponseTimeoutMs: 1000 },
    identity,
    expectedPeer: identity.publicKey,
    signal: stop.signal,
  })).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
});
