// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { startPinnedConnection } from '@/features/naidan-piping-duplex/connection';
import { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';
import { Deadline } from '@/features/naidan-piping-duplex/finite';
import { HandshakeResponseUnconfirmedError, PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

const calls = vi.hoisted(() => ({ discover: vi.fn(), establish: vi.fn() }));
vi.mock('@/features/naidan-piping-duplex/bootstrap', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/naidan-piping-duplex/bootstrap')>(),
  discoverCandidate: calls.discover,
}));
vi.mock('@/features/naidan-piping-duplex/key-context', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/naidan-piping-duplex/key-context')>(),
  establishVerifiedNaidanPipingKeys: calls.establish,
}));
useOfflineScope();

beforeEach(() => {
  calls.discover.mockReset(); calls.establish.mockReset();
});

function cancelled({ signal }: { signal: AbortSignal }): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

it.each(['retired', 'cleanup-failed'] as const)('bootstrap separates original establishment failure from %s cleanup', async outcome => {
  const stop = new AbortController(), original = new Error('Original pin rejection'), cleanup = new Error('Journal disposer failed');
  const channel = await RendezvousChannel.create({
    offer: new Uint8Array(),
    reply: new Uint8Array(),
    role: 'initiator',
    room: new Uint8Array(32).fill(1),
    attemptI: new Uint8Array(32).fill(2),
    attemptR: new Uint8Array(32).fill(3),
    challenge: new Uint8Array(32).fill(4),
  });
  vi.spyOn(channel, 'binding').mockResolvedValue(new Uint8Array(32));
  const dispose = channel.dispose.bind(channel);
  if (outcome === 'cleanup-failed') vi.spyOn(channel, 'dispose').mockImplementation(() => {
    dispose(); throw cleanup;
  });
  calls.discover.mockResolvedValue({ channel, peerPublicData: new Uint8Array(), confirmation: new Deadline({ parent: stop.signal, milliseconds: 5000 }) });
  calls.establish.mockRejectedValue(original);
  const task = await startPinnedConnection({
    responseTimeoutMs: 75_000,
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    code: 'ABCD-EFGH',
    signal: stop.signal,
    confirmationTimeoutMs: 5000,
    intervalMs: 2,
    purpose: new Uint8Array(),
    endpoint: { origin: 'https://relay.invalid', send: cancelled, receive: cancelled, repair: async () => {} },
  });
  const results = await Promise.allSettled([task.ready, task.completion, task.closed]);
  switch (outcome) {
  case 'retired':
    expect(results[0]).toEqual({ status: 'rejected', reason: original });
    expect(results[1]).toEqual({ status: 'rejected', reason: original });
    expect(results[2]).toEqual({ status: 'fulfilled', value: undefined });
    break;
  case 'cleanup-failed':
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(PipingRetirementError);
        expect(result.reason).toMatchObject({ logicalError: original, cause: cleanup });
      }
    }
    break;
  default: { const unreachable: never = outcome; throw new Error(String(unreachable)); }
  }
  stop.abort();
});

it('a cancelled candidate joins late crypto failure without replacing the first cancellation cause', async () => {
  const stop = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const cancelledError = new Error('First cancellation'), lateError = new Error('Late native crypto failure');
  const channel = await RendezvousChannel.create({
    offer: new Uint8Array(),
    reply: new Uint8Array(),
    role: 'initiator',
    room: new Uint8Array(32).fill(1),
    attemptI: new Uint8Array(32).fill(2),
    attemptR: new Uint8Array(32).fill(3),
    challenge: new Uint8Array(32).fill(4),
  });
  vi.spyOn(channel, 'binding').mockResolvedValue(new Uint8Array(32));
  calls.discover.mockResolvedValue({ channel, peerPublicData: new Uint8Array(), confirmation: new Deadline({ parent: stop.signal, milliseconds: 5000 }) });
  calls.establish.mockImplementation(async () => {
    entered.resolve(); await release.promise; throw lateError;
  });
  const task = await startPinnedConnection({
    responseTimeoutMs: 75_000,
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    code: 'ABCD-EFGH',
    signal: stop.signal,
    confirmationTimeoutMs: 5000,
    intervalMs: 2,
    purpose: new Uint8Array(),
    endpoint: { origin: 'https://relay.invalid', send: cancelled, receive: cancelled, repair: async () => {} },
  });
  let retired = false; void task.closed.then(() => {
    retired = true;
  });
  await entered.promise; stop.abort(cancelledError); await Promise.resolve(); expect(retired).toBe(false);
  release.resolve();
  await expect(task.ready).rejects.toBe(cancelledError);
  await expect(task.completion).rejects.toBe(cancelledError);
  await expect(task.closed).resolves.toBeUndefined();
});

it('response expiry stops HTTP immediately while native handshake work and HTTP cleanup stay joined', async () => {
  const stop = new AbortController(), entered = Promise.withResolvers<void>(), cryptoDone = Promise.withResolvers<void>();
  const httpAborted = Promise.withResolvers<void>(), httpRetired = Promise.withResolvers<void>();
  const error = new HandshakeResponseUnconfirmedError({ stage: 'confirmation' });
  const channel = await RendezvousChannel.create({
    offer: new Uint8Array(),
    reply: new Uint8Array(),
    role: 'initiator',
    room: new Uint8Array(32).fill(1),
    attemptI: new Uint8Array(32).fill(2),
    attemptR: new Uint8Array(32).fill(3),
    challenge: new Uint8Array(32).fill(4),
  });
  vi.spyOn(channel, 'binding').mockResolvedValue(new Uint8Array(32));
  calls.discover.mockResolvedValue({ channel, peerPublicData: new Uint8Array(), confirmation: new Deadline({ parent: stop.signal, milliseconds: 5000 }) });
  let onFailure: (({ error }: { error: unknown }) => void) | undefined;
  calls.establish.mockImplementation(async (args: { onResponseFailure: typeof onFailure }) => {
    onFailure = args.onResponseFailure; entered.resolve(); await cryptoDone.promise; throw error;
  });
  const endpoint = {
    origin: 'https://relay.invalid',
    send: cancelled,
    repair: async () => {},
    async receive({ signal }: { signal: AbortSignal }): Promise<Uint8Array> {
      try {
        return await cancelled({ signal });
      } finally {
        httpAborted.resolve(); await httpRetired.promise;
      }
    },
  };
  const task = await startPinnedConnection({
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    code: 'ABCD-EFGH',
    signal: stop.signal,
    responseTimeoutMs: 75_000,
    confirmationTimeoutMs: 5000,
    intervalMs: 2,
    purpose: new Uint8Array(),
    endpoint,
  });
  let retired = false; void task.closed.then(() => {
    retired = true;
  });
  try {
    await entered.promise; expect(onFailure).toBeTypeOf('function'); onFailure?.({ error });
    await httpAborted.promise; expect(retired).toBe(false);
    cryptoDone.resolve(); await Promise.resolve(); expect(retired).toBe(false);
    httpRetired.resolve();
    await expect(task.ready).rejects.toBe(error); await expect(task.completion).rejects.toBe(error);
    await expect(task.closed).resolves.toBeUndefined();
  } finally {
    stop.abort(); cryptoDone.resolve(); httpRetired.resolve(); await task.closed.catch(() => {});
  }
});

it.each(['confirmationTimeoutMs', 'intervalMs', 'responseTimeoutMs'] as const)('missing required %s fails before route lookup or discovery I/O', async field => {
  const origin = vi.fn(() => 'https://relay.invalid');
  const options = {
    role: 'initiator' as const,
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    code: 'ABCD-EFGH',
    signal: new AbortController().signal,
    confirmationTimeoutMs: 5000,
    responseTimeoutMs: 75_000,
    intervalMs: 2,
    purpose: new Uint8Array(),
    endpoint: {
      get origin() {
        return origin();
      },
      send: cancelled,
      receive: cancelled,
      repair: async () => {},
    },
  };
  // Exercise a malformed JavaScript caller without weakening the production type.
  Reflect.deleteProperty(options, field);
  await expect(startPinnedConnection(options)).rejects.toThrow('Connection timer duration');
  expect(origin).not.toHaveBeenCalled(); expect(calls.discover).not.toHaveBeenCalled(); expect(calls.establish).not.toHaveBeenCalled();
});

it('final advertised journals remain paced until explicit traffic-readiness retirement', async () => {
  const stop = new AbortController();
  const channel = await RendezvousChannel.create({
    offer: new Uint8Array(),
    reply: new Uint8Array(),
    role: 'initiator',
    room: new Uint8Array(32).fill(1),
    attemptI: new Uint8Array(32).fill(2),
    attemptR: new Uint8Array(32).fill(3),
    challenge: new Uint8Array(32).fill(4),
  });
  vi.spyOn(channel, 'binding').mockResolvedValue(new Uint8Array(32));
  const confirmation = new Deadline({ parent: stop.signal, milliseconds: 5000 }); confirmation.stopTimer();
  calls.discover.mockResolvedValue({ channel, peerPublicData: new Uint8Array(), confirmation });
  const transferred = { dispose: vi.fn() };
  calls.establish.mockResolvedValue({ keys: transferred, peerHandshakeData: new Uint8Array() });
  const send = vi.fn(async () => {});
  vi.useFakeTimers();
  const task = await startPinnedConnection({
    role: 'initiator',
    identity: { publicKey: new Uint8Array(32), privateKey: {} as CryptoKey },
    expectedPeer: new Uint8Array(32),
    verifyPeer: undefined,
    code: 'ABCD-EFGH',
    signal: stop.signal,
    responseTimeoutMs: 75_000,
    confirmationTimeoutMs: 5000,
    intervalMs: 2,
    purpose: new Uint8Array(),
    endpoint: { origin: 'https://relay.invalid', send, receive: cancelled, repair: async () => {} },
  });
  await task.ready;
  try {
    // First established advertisement enters the unchanged 5s wait.
    await vi.advanceTimersByTimeAsync(2);
    expect(send).toHaveBeenCalledTimes(2);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(count + 1);
    const closed = task.retire(); expect(closed).toBe(task.closed);
    await closed;
    const retiredCount = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(retiredCount);
    expect(stop.signal.aborted).toBe(false); expect(transferred.dispose).not.toHaveBeenCalled();
  } finally {
    stop.abort(); vi.useRealTimers(); await task.closed;
  }
});
