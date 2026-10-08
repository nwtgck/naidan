// @vitest-environment node
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';
import { StreamSession } from '@/features/naidan-piping-duplex/session';
import { PipingRetirementError, RecordExhaustedError } from '@/features/naidan-piping-duplex/lifetime';
import { keyPair, offeredCapsule, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';
import type { NaidanPipingDuplexOptions } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';

const calls = vi.hoisted(() => ({ start: vi.fn(), run: vi.fn() }));
vi.mock('@/features/naidan-piping-duplex/connection', () => ({ startPinnedConnection: calls.start }));
vi.mock('@/features/naidan-piping-duplex/runner', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/naidan-piping-duplex/runner')>(),
  runDuplex: calls.run,
}));
useOfflineScope();

beforeEach(() => {
  calls.start.mockReset(); calls.run.mockReset();
});

const piping: NaidanPipingDuplexOptions = {
  liveness: { intervalMs: 15_000, responseTimeoutMs: 75_000 },
  baseUrl: 'https://relay.invalid',
  policy: 'https-only',
  requestTimeoutMs: 50,
  repairTimeoutMs: 50,
  handshakeResponseTimeoutMs: 75_000,
  candidateConfirmationTimeoutMs: 100,
  pacing: { minimumMs: 2, idleResendIntervalMs: 100, retryBaseMs: 10, retryMaximumMs: 80 },
};

async function fixture() {
  const keys = await keyPair(), bootstrap = Promise.withResolvers<void>(), traffic = Promise.withResolvers<void>();
  void bootstrap.promise.catch(() => {}); void traffic.promise.catch(() => {});
  const control = { holdBootstrap: false };
  const retire = vi.fn(() => {
    if (!control.holdBootstrap) bootstrap.resolve();
    return bootstrap.promise;
  });
  calls.start.mockResolvedValue({ retire, ready: Promise.resolve({ keys: keys.a, peerHandshakeData: new Uint8Array(), peerPublicHandshakeData: new Uint8Array() }), completion: bootstrap.promise, closed: bootstrap.promise });
  const remote = await StreamSession.create({ keys: keys.b });
  calls.run.mockImplementation(async ({ session }: { session: StreamSession }) => {
    await remote.acceptCapsule({ capsule: await offeredCapsule({ session }) });
    await session.acceptCapsule({ capsule: await offeredCapsule({ session: remote }) });
    await traffic.promise;
  });
  const stop = new AbortController();
  onTestFinished(() => {
    stop.abort(); bootstrap.resolve(); traffic.resolve(); remote.abort({ reason: 'Test cleanup' });
  });
  const connect = () => NaidanPipingDuplexSession.connect({
    piping,
    code: 'ABCD-EFGH',
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: keys.b.peerIdentity,
    signal: stop.signal,
  });
  return { keys, bootstrap, traffic, stop, connect, control, retire, remote };
}

it('closed resolves after retired traffic failure, independently of the canonical ended cause', async () => {
  const state = await fixture(), session = await state.connect();
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  const error = new RecordExhaustedError(); streams.fail({ kind: 'record-exhausted', error });
  let retired = false; void session.closed.then(() => {
    retired = true;
  });
  await expect(session.ended).resolves.toEqual({ kind: 'record-exhausted', error });
  expect(retired).toBe(false); state.traffic.reject(error);
  await expect(session.closed).resolves.toBeUndefined();
  session.abort({ reason: 'Late cleanup' }); await expect(session.ended).resolves.toEqual({ kind: 'record-exhausted', error });
});

it('bootstrap retirement failure prevents publication and retains the first logical end', async () => {
  const state = await fixture(); state.control.holdBootstrap = true;
  const opening = state.connect(); void opening.catch(() => {});
  await vi.waitFor(() => expect(state.retire).toHaveBeenCalledOnce());
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  const original = new RecordExhaustedError();
  streams.fail({ kind: 'record-exhausted', error: original });
  const failure = new PipingRetirementError({ cause: new Error('Bootstrap owner cleanup failed'), logicalError: undefined });
  state.bootstrap.reject(failure); state.traffic.resolve();
  await expect(opening).rejects.toBeInstanceOf(PipingRetirementError);
  expect(await streams.ended).toEqual({ kind: 'record-exhausted', error: original });
});

it('factory cancellation joins late-created streams and bootstrap before rejecting', async () => {
  const state = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const create = StreamSession.create.bind(StreamSession); let streams: StreamSession | undefined;
  vi.spyOn(StreamSession, 'create').mockImplementation(async ({ keys }) => {
    streams = await create({ keys }); entered.resolve(); await release.promise; return streams;
  });
  const opening = state.connect(); let settled = false;
  void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise; state.stop.abort(new Error('Cancel factory'));
  expect(settled).toBe(false); expect(calls.run).not.toHaveBeenCalled();
  release.resolve();
  await vi.waitFor(() => expect(streams?.stopped).toBe(true));
  expect(settled).toBe(false); state.bootstrap.resolve();
  await expect(opening).rejects.toThrow('Cancel factory');
  expect(() => state.keys.a.createDomain({ label: 'test/late-factory', context: new Uint8Array() })).toThrow('disposed');
});

it('failed pre-publication retirement is not returned as an ordinary retryable factory error', async () => {
  const state = await fixture(), failure = new PipingRetirementError({ cause: new Error('Still owned'), logicalError: undefined });
  calls.start.mockResolvedValue({ retire: state.retire, ready: Promise.reject(new RecordExhaustedError()), completion: state.bootstrap.promise, closed: state.bootstrap.promise });
  state.bootstrap.reject(failure);
  await expect(state.connect()).rejects.toBeInstanceOf(PipingRetirementError);
  expect(calls.run).not.toHaveBeenCalled();
});

it('parent cancellation and explicit abort retain the exact first local cause', async () => {
  const state = await fixture(), session = await state.connect(), error = new Error('Original parent cancellation');
  state.stop.abort(error);
  await expect(session.ended).resolves.toEqual({ kind: 'local-stop', error });
  session.abort({ reason: 'Later local abort' });
  await expect(session.ended).resolves.toEqual({ kind: 'local-stop', error });
  state.traffic.resolve(); state.bootstrap.resolve(); await session.closed;
});

it('failed factory retirement retains both the original establishment cause and cleanup failure', async () => {
  const state = await fixture(), original = new Error('Peer pin mismatch');
  const cleanup = new PipingRetirementError({ cause: new Error('Bootstrap disposer failed'), logicalError: undefined });
  calls.start.mockResolvedValue({ retire: state.retire, ready: Promise.reject(original), completion: state.bootstrap.promise, closed: state.bootstrap.promise });
  const opening = state.connect(); let settled = false;
  void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  state.bootstrap.reject(cleanup);
  await expect(opening).rejects.toMatchObject({ logicalError: original, cause: cleanup });
});

it('parent cancellation remains primary if late native stream setup subsequently rejects', async () => {
  const state = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = new Error('First cancellation'), late = new Error('Late route derivation failure');
  vi.spyOn(StreamSession, 'create').mockImplementation(async () => {
    entered.resolve(); await release.promise; throw late;
  });
  const opening = state.connect(); void opening.catch(() => {});
  await entered.promise; state.stop.abort(original); release.resolve(); state.bootstrap.resolve();
  await expect(opening).rejects.toBe(original);
  expect(() => state.keys.a.createDomain({ label: 'test/late-rejection', context: new Uint8Array() })).toThrow('disposed');
});

it('synchronous logical-shutdown failure disposes keys after bootstrap already retired', async () => {
  const state = await fixture(), session = await state.connect();
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  const fail = streams.fail.bind(streams), original = new Error('Traffic failed'), cleanup = new Error('Shutdown callback failed');
  vi.spyOn(streams, 'fail').mockImplementation(args => {
    fail(args); throw cleanup;
  });
  const dispose = vi.spyOn(state.keys.a, 'dispose');
  state.traffic.reject(original);
  let retired = false; void session.closed.then(() => {
    retired = true;
  }, () => {
    retired = true;
  });
  await expect(session.ended).resolves.toEqual({ kind: 'transport-fatal', error: original });
  expect(state.retire).toHaveBeenCalledOnce();
  await expect(session.closed).rejects.toMatchObject({ logicalError: original });
  expect(retired).toBe(true);
  expect(dispose).toHaveBeenCalled();
});

it('keys alone never publish and cancelled first-echo wait joins the already constructed traffic owner', async () => {
  const state = await fixture(), entered = Promise.withResolvers<void>();
  calls.run.mockImplementation(() => {
    entered.resolve(); return state.traffic.promise;
  });
  let published = false, settled = false;
  const opening = state.connect(); void opening.then(() => {
    published = true; settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise; await Promise.resolve(); expect(published).toBe(false);
  const reason = new Error('Cancelled before fresh echo'); state.stop.abort(reason);
  await Promise.resolve(); expect(settled).toBe(false);
  state.bootstrap.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  state.traffic.resolve(); await expect(opening).rejects.toBe(reason); expect(published).toBe(false);
});

it('cancellation after echo commitment but before factory publication wins without orphaning traffic', async () => {
  const state = await fixture(), reason = new Error('Cancel at publication boundary');
  const original = StreamSession.prototype.startResponses;
  vi.spyOn(StreamSession.prototype, 'startResponses').mockImplementation(function (this: StreamSession, args) {
    original.call(this, args); void this.firstResponse.then(() => state.stop.abort(reason), () => {});
  });
  const opening = state.connect(); let settled = false; void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(state.stop.signal.aborted).toBe(true)); expect(settled).toBe(false);
  state.traffic.resolve(); state.bootstrap.resolve(); await expect(opening).rejects.toBe(reason);
});

it('pre-publication response expiry remains primary while traffic and bootstrap retirement stay owned', async () => {
  const state = await fixture(), entered = Promise.withResolvers<void>(), callbacks: (() => void)[] = [];
  let wall = 0;
  const original = StreamSession.prototype.startResponses;
  vi.spyOn(StreamSession.prototype, 'startResponses').mockImplementation(function (this: StreamSession, { policy }) {
    original.call(this, {
      policy,
      clock: {
        monotonic: () => 0,
        wall: () => wall,
        schedule({ callback }) {
          callbacks.push(callback); return () => {};
        },
      },
    });
  });
  calls.run.mockImplementation(() => {
    entered.resolve(); return state.traffic.promise;
  });
  const opening = state.connect(); let settled = false; void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise; wall = 75_000; callbacks[0]!();
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  await expect(streams.ended).resolves.toMatchObject({ kind: 'response-unconfirmed' });
  expect(streams.stoppedSignal.aborted).toBe(true); expect(settled).toBe(false);
  state.traffic.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  state.bootstrap.resolve(); await expect(opening).rejects.toMatchObject({ name: 'ResponseUnconfirmedError' });
});

it('an immediate runner failure before first echo retains its exact cause through factory retirement', async () => {
  const state = await fixture(), original = new Error('Immediate traffic owner failure');
  calls.run.mockRejectedValue(original);
  const opening = state.connect(); let settled = false; void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(calls.run).toHaveBeenCalledOnce());
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  await expect(streams.ended).resolves.toMatchObject({ error: original }); expect(settled).toBe(false);
  state.bootstrap.resolve(); await expect(opening).rejects.toBe(original);
});

it.each([undefined, null, {}, { intervalMs: 0, responseTimeoutMs: 75_000 }, { intervalMs: 15_000, responseTimeoutMs: NaN }])('invalid explicit liveness configuration fails before discovery: %j', async liveness => {
  await expect(NaidanPipingDuplexSession.connect({
    piping: { ...piping, liveness } as NaidanPipingDuplexOptions,
    code: 'ABCD-EFGH',
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    signal: new AbortController().signal,
  })).rejects.toThrow();
  expect(calls.start).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('failed first-window timer disposal blocks publication and remains a retirement failure after joins', async () => {
  const state = await fixture(), cleanup = new Error('Timer retirement unconfirmed');
  const original = StreamSession.prototype.startResponses, scheduled = vi.fn(() => () => {
    throw cleanup;
  });
  vi.spyOn(StreamSession.prototype, 'startResponses').mockImplementation(function (this: StreamSession, { policy }) {
    original.call(this, { policy, clock: { monotonic: () => 0, wall: () => 0, schedule: scheduled } });
  });
  let published = false, settled = false;
  const opening = state.connect(); void opening.then(() => {
    published = true; settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(calls.run).toHaveBeenCalledOnce());
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  await expect(streams.ended).resolves.toMatchObject({ error: cleanup });
  expect(published).toBe(false); expect(settled).toBe(false); expect(scheduled).toHaveBeenCalledOnce();
  state.traffic.resolve(); state.bootstrap.resolve();
  await expect(opening).rejects.toMatchObject({ name: 'PipingRetirementError', logicalError: cleanup });
});

it('first echo retires bootstrap while traffic still supplies the peer echo before publication', async () => {
  const state = await fixture(); state.control.holdBootstrap = true;
  state.remote.startResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 } });
  let peerReady = false, published = false;
  void state.remote.firstResponse.then(() => {
    peerReady = true;
  });
  const opening = state.connect(); void opening.then(() => {
    published = true;
  });
  await vi.waitFor(() => expect(state.retire).toHaveBeenCalledOnce());
  expect(published).toBe(false); expect(peerReady).toBe(false);
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  expect(streams.stopped).toBe(false); expect(state.stop.signal.aborted).toBe(false);
  await state.remote.acceptCapsule({ capsule: await offeredCapsule({ session: streams }) });
  await state.remote.firstResponse;
  expect(peerReady).toBe(true); expect(published).toBe(false);
  state.bootstrap.resolve(); const connection = await opening;
  expect(connection.peerHandshakeData).toEqual(new Uint8Array());
  expect(await state.keys.a.createDomain({ label: 'test/after-bootstrap', context: new Uint8Array() }).route({ direction: 1 })).not.toHaveLength(0);
  connection.abort({ reason: 'Test cleanup' }); state.traffic.resolve(); await connection.closed;
});

it('cancellation during bootstrap retirement immediately stops traffic and joins both owners', async () => {
  const state = await fixture(); state.control.holdBootstrap = true;
  const opening = state.connect(); let settled = false;
  void opening.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(state.retire).toHaveBeenCalledOnce());
  const streams: StreamSession = calls.run.mock.lastCall![0].session;
  const reason = new Error('Cancel held bootstrap retirement'); state.stop.abort(reason);
  expect(streams.stoppedSignal.aborted).toBe(true); expect(settled).toBe(false);
  state.bootstrap.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  state.traffic.resolve(); await expect(opening).rejects.toBe(reason);
  expect(state.retire).toHaveBeenCalledOnce();
});
