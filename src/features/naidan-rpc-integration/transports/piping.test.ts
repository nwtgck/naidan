import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createRpcProtocolAdvertisement, NaidanRpcProtocolError } from '@/features/naidan-rpc';
import { PipingRetirementError } from '@/features/naidan-piping-duplex';
import { openPipingRpc, describePipingRpcProtocolFailure } from './piping';
import { encodePeerKey } from '@/features/naidan-rpc-integration/runtime/identity';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex';
const calls = vi.hoisted(() => ({ connect: vi.fn(), pair: vi.fn(), prepare: vi.fn(), session: vi.fn() }));
vi.mock('@/features/naidan-piping-duplex/naidan-piping-duplex-session', () => ({
  NaidanPipingDuplexSession: { pair: calls.pair, connectPinned: calls.connect, preparePinnedContact: calls.prepare },
}));

type ConnectionStub = { peerPublicHandshakeData: Uint8Array; abort(): void; closed: Promise<void>; peerIdentity?: Uint8Array };
function sessionFor({ connection }: { connection: ConnectionStub }) {
  return {
    get peerPublicHandshakeData() {
      return connection.peerPublicHandshakeData;
    },
    peerIdentity: connection.peerIdentity ?? b.publicKey,
    contextId: new Uint8Array(32).fill(91),
    incomingStreams: { async *[Symbol.asyncIterator]() {} },
    ended: Promise.withResolvers<never>().promise,
    closed: connection.closed,
    abort: () => connection.abort(),
    close: async () => {
      connection.abort(); await connection.closed; return { notification: 'acknowledged' as const };
    },
    openStream: async () => {
      throw new Error('Unused test stream');
    },
    health: { state: 'healthy' as const },
    subscribeHealth: () => () => {},
  };
}

beforeEach(() => {
  calls.prepare.mockReset();
  const connection = { peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: Promise.resolve() };
  calls.session.mockImplementation(async ({ expectedPeer }: { expectedPeer: Uint8Array }) => ({ ...connection, peerIdentity: expectedPeer }));
  calls.connect.mockImplementation(async args => sessionFor({ connection: await calls.session(args) }));
  calls.pair.mockImplementation(async ({ identity }: { identity: NaidanPipingIdentity }) => sessionFor({ connection: { ...connection, peerIdentity: identity === a ? b.publicKey : a.publicKey } }));
});

afterEach(() => vi.clearAllMocks());

const settings = { type: 'naidan_piping_duplex' as const, serverUrl: 'https://relay.example', headers: [] };
const a: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(1) };
const b: NaidanPipingIdentity = { privateKey: {} as CryptoKey, publicKey: new Uint8Array(32).fill(2) };

it('passes reciprocal pinned identities and one stable purpose to the endpoint owner', async () => {
  for (const [local, remote] of [[a, b], [b, a]] as const) await openPipingRpc({
    settings,
    identity: local,
    peerKey: encodePeerKey({ bytes: remote.publicKey }),
    code: undefined,
    verifyPeer: undefined,
    signal: new AbortController().signal,
  });
  const first = calls.connect.mock.calls[0]![0], second = calls.connect.mock.calls[1]![0];
  expect(first.piping.handshakeResponseTimeoutMs).toBe(75_000);
  expect(first.piping.liveness).toBeUndefined();
  expect(first.purpose).toBe('naidan-rpc/registered-peer/v1'); expect(second.purpose).toBe(first.purpose);
  expect(first.identity).toBe(a); expect(first.expectedPeer).toEqual(b.publicKey);
  expect(second.identity).toBe(b); expect(second.expectedPeer).toEqual(a.publicKey);
  expect(calls.pair).not.toHaveBeenCalled();
});

it('does not treat relay credentials as part of the shared route namespace', async () => {
  const common = { identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal };
  await openPipingRpc({ ...common, settings });
  await openPipingRpc({ ...common, settings: { ...settings, headers: [{ name: 'Authorization', value: 'secret' }] } });
  const first = calls.connect.mock.calls[0]![0], second = calls.connect.mock.calls[1]![0];
  expect(first.purpose).toBe(second.purpose); expect(first.expectedPeer).toEqual(second.expectedPeer);
  expect(first.piping.baseUrl).toBe(second.piping.baseUrl);
  expect(second.piping.headers).toEqual([{ name: 'Authorization', value: 'secret' }]);
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
  expect(first.piping.liveness).toBeUndefined();
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

it.each(['connect', 'pair'] as const)('%s advertises public RPC identity and accepts authenticated absence', async mode => {
  const common = { settings, identity: a, signal: new AbortController().signal };
  await openPipingRpc({
    ...common,
    peerKey: mode === 'connect' ? encodePeerKey({ bytes: b.publicKey }) : undefined,
    code: mode === 'pair' ? '1234' : undefined,
    verifyPeer: mode === 'pair' ? async () => true : undefined,
  });
  const args = (mode === 'connect' ? calls.connect : calls.pair).mock.calls[0]![0];
  expect(args.publicHandshakeData).toEqual(createRpcProtocolAdvertisement()); expect(args.handshakeData).toBeUndefined();
});

it.each(['retired', 'failed'] as const)('authenticated incompatible advertisement retains its primary cause through %s cleanup', async outcome => {
  const bytes = createRpcProtocolAdvertisement(); new DataView(bytes.buffer).setUint32(9, 0x80000002, true);
  const gate = Promise.withResolvers<void>(), cleanup = new Error('Native retirement failed'), abort = vi.fn();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: bytes, abort, closed: gate.promise });
  const opening = openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  let settled = false; void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce()); expect(settled).toBe(false);
  if (outcome === 'failed') gate.reject(cleanup); else gate.resolve();
  const error: unknown = await opening.catch(error => error);
  const original = error instanceof PipingRetirementError ? error.logicalError : error;
  expect(original).toBeInstanceOf(NaidanRpcProtocolError);
  expect(describePipingRpcProtocolFailure({ error })).toContain('experimental revision 2');
  if (outcome === 'failed') expect(error).toMatchObject({ cause: cleanup, logicalError: original });
});

it('synchronous abort failure still joins the rejected authenticated connection', async () => {
  const gate = Promise.withResolvers<void>(), cleanup = new Error('Abort failed');
  const abort = vi.fn(() => {
    throw cleanup;
  });
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array([1]), abort, closed: gate.promise });
  const opening = openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  let settled = false; void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce()); expect(settled).toBe(false); gate.resolve();
  await expect(opening).rejects.toMatchObject({ cause: cleanup, logicalError: { diagnostic: { kind: 'truncated-header' } } });
});

it('arbitrary errors and metadata-getter lookalikes do not acquire authenticated advertisement provenance', async () => {
  const lookalike = new NaidanRpcProtocolError({ diagnostic: { kind: 'unsupported-protocol-version', version: 1 } });
  expect(describePipingRpcProtocolFailure({ error: lookalike })).toBeUndefined();
  const abort = vi.fn(); calls.session.mockResolvedValueOnce({
    get peerPublicHandshakeData() {
      throw lookalike;
    },
    abort,
    closed: Promise.resolve(),
  });
  const opening = openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  await expect(opening).rejects.toBe(lookalike); expect(abort).toHaveBeenCalledOnce(); expect(describePipingRpcProtocolFailure({ error: lookalike })).toBeUndefined();
});

it('forwards cancellation before adoption and detaches only after recording the session owner', async () => {
  const retirement = Promise.withResolvers<void>();
  calls.session.mockImplementation(async () => ({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: retirement.promise }));
  const first = new AbortController();
  const held = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: first.signal });
  const physical: AbortSignal = calls.connect.mock.calls[0]![0].signal;
  held.session!.adopt(); first.abort(); expect(physical.aborted).toBe(false);
  const second = new AbortController();
  await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: second.signal });
  const pending: AbortSignal = calls.connect.mock.calls[1]![0].signal;
  second.abort(); expect(pending.aborted).toBe(true); retirement.resolve();
});

it.each([401, 403, 404])('does not turn HTTP %s configuration failures into retryable peer failures', async status => {
  const { PipingStatusError } = await import('@/features/naidan-piping-duplex/finite-transfer');
  const error = new PipingStatusError({ status }); calls.connect.mockRejectedValueOnce(error);
  await expect(openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal })).rejects.toBe(error);
  expect(describePipingRpcProtocolFailure({ error })).toBeUndefined();
});

it.each([400, 408, 429, 500, 503])('retains bounded retry for HTTP %s without claiming peer authentication', async status => {
  const { PipingStatusError } = await import('@/features/naidan-piping-duplex/finite-transfer');
  const { RpcTransportInterruptedError } = await import('./piping');
  const error = new PipingStatusError({ status }); calls.connect.mockRejectedValueOnce(error);
  const failure: unknown = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal }).catch(error => error);
  expect(failure).toBeInstanceOf(RpcTransportInterruptedError); expect(describePipingRpcProtocolFailure({ error: failure })).toBeUndefined();
});

it('rejects an incompatible authenticated candidate without stopping the live connection', async () => {
  const oldClosed = Promise.withResolvers<void>(), oldAbort = vi.fn();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: oldAbort, closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const bytes = createRpcProtocolAdvertisement(); new DataView(bytes.buffer).setUint32(9, 0x80000002, true);
  const reclaimed = Promise.withResolvers<void>(), dispose = vi.fn(() => reclaimed.promise), finish = vi.fn();
  calls.prepare.mockResolvedValueOnce({ kind: 'candidate', assertAvailable() {}, peerPublicHandshakeData: bytes, finish, dispose });
  const opening = link.session!.prepareReplacement!({ signal: new AbortController().signal });
  void opening.catch(() => {});
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(oldAbort).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  reclaimed.resolve(); const error: unknown = await opening.catch(error => error);
  expect(describePipingRpcProtocolFailure({ error })).toContain('experimental revision 2');
  expect(calls.prepare.mock.calls[0]![0].heldContext).toEqual(new Uint8Array(32).fill(91));
  oldClosed.resolve();
});

it('claims a candidate once without aborting the adopted successor on double disposal', async () => {
  const oldClosed = Promise.withResolvers<void>(), nextClosed = Promise.withResolvers<void>();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const nextAbort = vi.fn(), dispose = vi.fn(), finish = vi.fn(async () => sessionFor({ connection: { peerPublicHandshakeData: createRpcProtocolAdvertisement(), abort: nextAbort, closed: nextClosed.promise } }));
  calls.prepare.mockResolvedValueOnce({ kind: 'candidate', assertAvailable() {}, peerPublicHandshakeData: createRpcProtocolAdvertisement(), finish, dispose });
  const intent = new AbortController(), candidate = await link.session!.prepareReplacement!({ signal: intent.signal });
  const physical: AbortSignal = calls.prepare.mock.calls[0]![0].signal;
  const successor = await candidate!.finish(); successor.session!.adopt(); intent.abort();
  await expect(candidate!.dispose()).rejects.toThrow('already consumed');
  await expect(candidate!.finish()).rejects.toThrow('already consumed');
  expect(finish).toHaveBeenCalledOnce(); expect(dispose).not.toHaveBeenCalled();
  expect(physical.aborted).toBe(false); expect(nextAbort).not.toHaveBeenCalled();
  nextClosed.resolve(); oldClosed.resolve();
});

it('retires a candidate that arrives after its connection intent was cancelled', async () => {
  const oldClosed = Promise.withResolvers<void>(), oldAbort = vi.fn();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: oldAbort, closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const ready = Promise.withResolvers<{ kind: 'candidate'; assertAvailable(): void; peerPublicHandshakeData: Uint8Array; finish: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>();
  calls.prepare.mockReturnValueOnce(ready.promise);
  const intent = new AbortController(), opening = link.session!.prepareReplacement!({ signal: intent.signal });
  void opening.catch(() => {}); intent.abort(new Error('Disconnect'));
  const dispose = vi.fn(async () => {}), finish = vi.fn();
  ready.resolve({ kind: 'candidate', assertAvailable() {}, peerPublicHandshakeData: createRpcProtocolAdvertisement(), dispose, finish });
  await expect(opening).rejects.toThrow('Disconnect'); expect(dispose).toHaveBeenCalledOnce();
  expect(finish).not.toHaveBeenCalled(); expect(oldAbort).not.toHaveBeenCalled(); oldClosed.resolve();
});

it('keeps a post-adoption setup interruption retryable instead of permanently blocking reconnection', async () => {
  const { RpcTransportInterruptedError } = await import('./piping');
  const oldClosed = Promise.withResolvers<void>();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const interruption = new Error('Connection owner aborted');
  calls.prepare.mockResolvedValueOnce({
    kind: 'candidate',
    assertAvailable() {},
    peerPublicHandshakeData: createRpcProtocolAdvertisement(),
    finish: async () => {
      throw interruption;
    },
    dispose: vi.fn(),
  });
  try {
    const candidate = await link.session!.prepareReplacement!({ signal: new AbortController().signal });
    const error: unknown = await candidate!.finish().catch(error => error);
    expect(error).toBeInstanceOf(RpcTransportInterruptedError);
    expect(error).toMatchObject({ cause: interruption });
    expect(describePipingRpcProtocolFailure({ error })).toBeUndefined();
  } finally {
    oldClosed.resolve();
  }
});

it('does not hide a failed handshake retirement behind simultaneous caller cancellation', async () => {
  const stop = new AbortController(), started = Promise.withResolvers<void>();
  const failure = new PipingRetirementError({ cause: new Error('Response cancellation failed'), logicalError: new Error('Interrupted handshake') });
  calls.connect.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(failure), { once: true }); started.resolve();
  }));
  const opening = openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: stop.signal });
  const rejected = expect(opening).rejects.toBe(failure);
  await started.promise; stop.abort(new Error('User stopped the connection')); await rejected;
});

it.each([401, 403, 404, 408, 429, 503])('keeps HTTP %s policy consistent when a replacement fails after admission', async status => {
  const { PipingStatusError } = await import('@/features/naidan-piping-duplex/finite-transfer');
  const { RpcTransportInterruptedError } = await import('./piping');
  const oldClosed = Promise.withResolvers<void>(), failure = new PipingStatusError({ status });
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  calls.prepare.mockResolvedValueOnce({
    kind: 'candidate',
    assertAvailable() {},
    peerPublicHandshakeData: createRpcProtocolAdvertisement(),
    finish: async () => {
      throw failure;
    },
    dispose: vi.fn(),
  });
  try {
    const candidate = await link.session!.prepareReplacement!({ signal: new AbortController().signal });
    const error: unknown = await candidate!.finish().catch(error => error);
    if (status === 401 || status === 403 || status === 404) expect(error).toBe(failure);
    else {
      expect(error).toBeInstanceOf(RpcTransportInterruptedError); expect(error).toMatchObject({ cause: failure });
    }
    expect(describePipingRpcProtocolFailure({ error })).toBeUndefined();
  } finally {
    oldClosed.resolve();
  }
});

it.each([false, true])('keeps replacement cleanup failure terminal with cancellation=%s', async cancelled => {
  const oldClosed = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const failure = new PipingRetirementError({ cause: new Error('Replacement body did not retire'), logicalError: new Error('Failed READY') });
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const finish = Promise.withResolvers<never>(), intent = new AbortController();
  calls.prepare.mockResolvedValueOnce({
    kind: 'candidate',
    assertAvailable() {},
    peerPublicHandshakeData: createRpcProtocolAdvertisement(),
    finish: () => {
      started.resolve(); return finish.promise;
    },
    dispose: vi.fn(),
  });
  try {
    const candidate = await link.session!.prepareReplacement!({ signal: intent.signal });
    const finishing = candidate!.finish(), rejection = expect(finishing).rejects.toBe(failure);
    await started.promise;
    if (cancelled) intent.abort(new Error('Disconnected'));
    finish.reject(failure); await rejection;
  } finally {
    oldClosed.resolve();
  }
});

it.each([undefined, null])('keeps an untyped replacement rejection (%s) retryable', async failure => {
  const { RpcTransportInterruptedError } = await import('./piping');
  const oldClosed = Promise.withResolvers<void>();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  calls.prepare.mockResolvedValueOnce({
    kind: 'candidate',
    assertAvailable() {},
    peerPublicHandshakeData: createRpcProtocolAdvertisement(),
    finish: async () => {
      throw failure;
    },
    dispose: vi.fn(),
  });
  try {
    const candidate = await link.session!.prepareReplacement!({ signal: new AbortController().signal });
    const error: unknown = await candidate!.finish().catch(error => error);
    expect(error).toBeInstanceOf(RpcTransportInterruptedError); expect(error).toMatchObject({ cause: failure });
  } finally {
    oldClosed.resolve();
  }
});

it('does not reclassify authenticated successor metadata as a retryable setup interruption', async () => {
  const oldClosed = Promise.withResolvers<void>(), nextClosed = Promise.withResolvers<void>(), nextAbort = vi.fn();
  calls.session.mockResolvedValueOnce({ peerPublicHandshakeData: new Uint8Array(), abort: vi.fn(), closed: oldClosed.promise });
  const link = await openPipingRpc({ settings, identity: a, peerKey: encodePeerKey({ bytes: b.publicKey }), code: undefined, verifyPeer: undefined, signal: new AbortController().signal });
  const invalid = createRpcProtocolAdvertisement(); new DataView(invalid.buffer).setUint32(9, 0x80000002, true);
  calls.prepare.mockResolvedValueOnce({ kind: 'candidate', assertAvailable() {}, peerPublicHandshakeData: createRpcProtocolAdvertisement(), finish: async () => sessionFor({ connection: { peerPublicHandshakeData: invalid, abort: nextAbort, closed: nextClosed.promise } }), dispose: vi.fn() });
  try {
    const candidate = await link.session!.prepareReplacement!({ signal: new AbortController().signal });
    const finishing = candidate!.finish().catch(error => error); let settled = false;
    void finishing.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(nextAbort).toHaveBeenCalledOnce()); expect(settled).toBe(false);
    nextClosed.resolve(); const error: unknown = await finishing;
    expect(error).toBeInstanceOf(NaidanRpcProtocolError);
    expect(describePipingRpcProtocolFailure({ error })).toContain('experimental revision 2');
  } finally {
    nextClosed.resolve(); oldClosed.resolve();
  }
});
