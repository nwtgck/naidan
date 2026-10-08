import { PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import { ownBytes, requireValue, fields, ascii } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, sleep, needsSenderRepair } from '@/features/naidan-piping-duplex/finite';
import type { Deadline, FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { DiscoveryObservations, RestartDiscoveryError, discoverCandidate } from '@/features/naidan-piping-duplex/bootstrap';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingKeyContext, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { rendezvousRoom } from '@/features/naidan-piping-duplex/rendezvous';
import type { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import { isInitiator } from '@/features/naidan-piping-duplex/role';

export type EstablishedConnection = { keys: NaidanPipingKeyContext; peerHandshakeData: Uint8Array; peerPublicHandshakeData: Uint8Array };
export type PinnedConnectionTask = {
  readonly ready: Promise<EstablishedConnection>;
  /** Logical bootstrap outcome after its work has joined; retained for direct callers. */
  readonly completion: Promise<void>;
  /** Pure retirement barrier; ordinary bootstrap failure/cancellation is not cleanup failure. */
  readonly closed: Promise<void>;
  /** Stop only bootstrap work; transferred traffic keys remain caller-owned. */
  retire(): Promise<void>;
};

/** Owns one selected candidate and its retained cumulative handshake; it never replays Noise. */
async function runCandidate({ channel, confirmation, identity, expectedPeer, verifyPeer, purpose, endpoint,
  signal, intervalMs, responseTimeoutMs, onReady, handshakeData, peerPublicHandshakeData }: {
  channel: RendezvousChannel; confirmation: Deadline; identity: NaidanPipingIdentity;
  expectedPeer: Uint8Array | undefined; verifyPeer: NaidanPipingPeerVerifier | undefined; purpose: Uint8Array;
  endpoint: FiniteTransport; signal: AbortSignal; intervalMs: number; responseTimeoutMs: number;
  handshakeData: Uint8Array; peerPublicHandshakeData: Uint8Array;
  onReady({ result }: { result: EstablishedConnection }): void;
}): Promise<void> {
  const stop = new AbortController();
  const activeSignal = AbortSignal.any([signal, stop.signal, confirmation.signal]);
  const retirementFailures: unknown[] = [];
  let logicalFailure: { error: unknown } | undefined;
  const recordStop = () => {
    logicalFailure ??= { error: activeSignal.reason };
  };
  activeSignal.addEventListener('abort', recordStop, { once: true });
  if (activeSignal.aborted) recordStop();
  let established = false;
  let finalAdvertised = false;
  const pause = () => established && finalAdvertised ? Math.max(intervalMs, 5000) : intervalMs;
  const guarded = async ({ task }: { task(): Promise<void> }) => {
    try {
      await task();
    } catch (error) {
      if (error instanceof PipingRetirementError) retirementFailures.push(error);
      stop.abort(error);
    }
  };
  const send = async () => {
    while (!activeSignal.aborted) {
      const post = new AbortController();
      const advanced = new Error('Handshake advertisement advanced');
      const revision = channel.revision;
      const bytes = channel.snapshot();
      const postSignal = AbortSignal.any([activeSignal, post.signal]);
      // A cumulative journal can safely replace its old prefix after either peer or local progress.
      const updated = channel.waitForChange({ revision, signal: postSignal }).then(() => post.abort(advanced), () => {});
      try {
        const wasEstablished = established;
        await endpoint.send({ route: channel.routes.send, bytes, signal: postSignal });
        if (wasEstablished) finalAdvertised = true;
      } catch (error) {
        if (error instanceof PipingRetirementError) throw error;
        activeSignal.throwIfAborted();
        if (post.signal.reason !== advanced) {
          if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
          if (needsSenderRepair({ kind: error.kind })) await endpoint.repair({ route: channel.routes.send, signal: activeSignal });
        }
      } finally {
        post.abort();
        await updated;
      }
      await sleep({ milliseconds: pause(), signal: activeSignal });
    }
  };
  const receive = async () => {
    while (!activeSignal.aborted) {
      try {
        channel.accept({ bytes: await endpoint.receive({ route: channel.routes.receive, signal: activeSignal }) });
        // ACK confirms SELECT; the responder's first Noise flight proves its ACK arrived.
        if (isInitiator({ role: channel.role }) ? channel.bound : channel.peerStartedNoise) confirmation.stopTimer();
      } catch (error) {
        if (error instanceof PipingRetirementError) throw error;
        activeSignal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
      }
      await sleep({ milliseconds: pause(), signal: activeSignal });
    }
  };
  const jobs = [guarded({ task: send }), guarded({ task: receive })];
  try {
    const discoveryBinding = await channel.binding({ signal: activeSignal });
    const binding = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({
      parts: [
        ascii({ text: 'naidan-piping-purpose/v1' }), discoveryBinding, purpose,
      ],
    })));
    const { keys, peerHandshakeData } = await establishVerifiedNaidanPipingKeys({
      role: channel.role,
      identity,
      expectedPeer,
      verifyPeer,
      binding,
      channel,
      signal: activeSignal,
      responseTimeoutMs,
      handshakeData,
      onResponseFailure: ({ error }) => stop.abort(error),
    });
    if (activeSignal.aborted) {
      keys.dispose(); peerHandshakeData.fill(0); activeSignal.throwIfAborted();
    }
    established = true;
    onReady({ result: { keys, peerHandshakeData, peerPublicHandshakeData } });
    // Keep advertising until the managed owner proves traffic readiness, then
    // stops this bootstrap. The existing I/O jobs own the wait and its cleanup.
    await Promise.all(jobs);
  } catch (error) {
    logicalFailure ??= { error };
    if (!established && !signal.aborted && confirmation.signal.aborted && logicalFailure.error === confirmation.signal.reason) {
      logicalFailure = { error: new RestartDiscoveryError() };
    }
  } finally {
    // Stop all owners even if one synchronous disposer fails, then join I/O.
    const failures = retirementFailures;
    for (const dispose of [() => stop.abort(), () => confirmation.dispose()]) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.allSettled(jobs);
    activeSignal.removeEventListener('abort', recordStop);
    try {
      channel.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (retirementFailures.length) throw new PipingRetirementError({ cause: retirementFailures[0], logicalError: logicalFailure?.error });
  if (logicalFailure) throw logicalFailure.error;
}

/** Discovery and human comparison remain untimed; selected candidates and required machine responses have separate windows. */
export async function startPinnedConnection({ role, identity, expectedPeer, code, endpoint, signal: parent, confirmationTimeoutMs,
  intervalMs, purpose, verifyPeer, responseTimeoutMs, publicHandshakeData = new Uint8Array(), handshakeData = new Uint8Array() }: {
  publicHandshakeData?: Uint8Array; handshakeData?: Uint8Array;
  role: NaidanPipingRole | undefined; identity: NaidanPipingIdentity; expectedPeer: Uint8Array | undefined;
  verifyPeer: NaidanPipingPeerVerifier | undefined; code: string; endpoint: FiniteTransport; signal: AbortSignal;
  confirmationTimeoutMs: number; intervalMs: number; purpose: Uint8Array; responseTimeoutMs: number;
}): Promise<PinnedConnectionTask> {
  for (const value of [confirmationTimeoutMs, intervalMs, responseTimeoutMs])
    requireValue({ condition: Number.isInteger(value) && value > 0 && value <= 2147483647, message: 'Connection timer duration' });
  const stop = new AbortController();
  const signal = AbortSignal.any([parent, stop.signal]);
  const publicData = ownBytes({ bytes: publicHandshakeData, maxBytes: 256 }), privateData = ownBytes({ bytes: handshakeData, maxBytes: 463 });
  const observations = new DiscoveryObservations();
  const purposeBytes = ownBytes({ bytes: purpose, maxBytes: 256 });
  const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 });
  requireValue({ condition: pin?.length === 32 || (pin === undefined && verifyPeer !== undefined), message: 'Expected pin or explicit peer comparison required' });
  const localIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  signal.throwIfAborted();
  const room = await rendezvousRoom({ code, origin: endpoint.origin });
  signal.throwIfAborted();
  const owner = crypto.getRandomValues(new Uint8Array(16));
  const ready = Promise.withResolvers<EstablishedConnection>();
  void ready.promise.catch(() => {});
  const completion = (async () => {
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          const { channel, confirmation, peerPublicData } = await discoverCandidate({
            role,
            room,
            endpoint,
            owner,
            signal,
            confirmationTimeoutMs,
            intervalMs,
            publicData,
            observations,
          });
          await runCandidate({
            channel,
            confirmation,
            identity: localIdentity,
            expectedPeer: pin,
            verifyPeer,
            purpose: purposeBytes,
            endpoint,
            signal,
            intervalMs,
            responseTimeoutMs,
            handshakeData: privateData,
            peerPublicHandshakeData: peerPublicData,
            onReady: ({ result }) => ready.resolve(result),
          });
          return;
        } catch (error) {
          if (!(error instanceof RestartDiscoveryError)) throw error;
          signal.throwIfAborted();
          await sleep({ milliseconds: intervalMs, signal });
        }
      }
    } catch (error) {
      ready.reject(error); throw error;
    } finally {
      owner.fill(0); room.fill(0); publicData.fill(0); privateData.fill(0);
    }
  })();
  void completion.catch(() => {});
  const closed = completion.catch(error => {
    if (error instanceof PipingRetirementError) throw error;
  });
  void closed.catch(() => {});
  return {
    ready: ready.promise,
    completion,
    closed,
    retire() {
      stop.abort(new Error('Bootstrap retired'));
      return closed;
    },
  };
}

export const TEST_ONLY = {
};
