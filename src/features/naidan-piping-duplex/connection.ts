import { ownBytes, requireValue, fields, ascii } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, sleep, needsSenderRepair } from '@/features/naidan-piping-duplex/finite';
import type { Deadline, FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { RestartDiscoveryError, discoverCandidate } from '@/features/naidan-piping-duplex/bootstrap';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingKeyContext, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { rendezvousRoom } from '@/features/naidan-piping-duplex/rendezvous';
import type { RendezvousChannel } from '@/features/naidan-piping-duplex/rendezvous';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import { isInitiator } from '@/features/naidan-piping-duplex/role';

export type PinnedConnectionTask = {
  readonly ready: Promise<NaidanPipingKeyContext>;
  readonly completion: Promise<void>;
};

/** Owns one selected candidate and its retained cumulative handshake; it never replays Noise. */
async function runCandidate({ channel, confirmation, identity, expectedPeer, verifyPeer, purpose, endpoint,
  signal, completionLeaseMs, intervalMs, onReady }: {
  channel: RendezvousChannel; confirmation: Deadline; identity: NaidanPipingIdentity;
  expectedPeer: Uint8Array | undefined; verifyPeer: NaidanPipingPeerVerifier | undefined; purpose: Uint8Array;
  endpoint: FiniteTransport; signal: AbortSignal; completionLeaseMs: number | undefined; intervalMs: number;
  onReady({ keys }: { keys: NaidanPipingKeyContext }): void;
}): Promise<void> {
  const stop = new AbortController();
  const activeSignal = AbortSignal.any([signal, stop.signal, confirmation.signal]);
  let established = false;
  let finalAdvertised = false;
  const pause = () => established && finalAdvertised && completionLeaseMs === undefined ? Math.max(intervalMs, 5000) : intervalMs;
  const guarded = async ({ task }: { task(): Promise<void> }) => {
    try {
      await task();
    } catch (error) {
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
        activeSignal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
      }
      await sleep({ milliseconds: pause(), signal: activeSignal });
    }
  };
  const jobs = [guarded({ task: send }), guarded({ task: receive })];
  try {
    const discoveryBinding = await channel.binding({ signal: activeSignal });
    const binding = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({ parts: [
      ascii({ text: 'naidan-piping-purpose/v1' }), discoveryBinding, purpose,
    ] })));
    const keys = await establishVerifiedNaidanPipingKeys({ role: channel.role, identity, expectedPeer, verifyPeer,
      binding, channel, signal: activeSignal });
    if (activeSignal.aborted) {
      keys.dispose(); activeSignal.throwIfAborted();
    }
    established = true;
    onReady({ keys });
    // The peer might still need the final journal. Traffic owns separate HTTP requests.
    if (completionLeaseMs === undefined) {
      await new Promise<void>((_resolve, reject) => {
        if (activeSignal.aborted) reject(activeSignal.reason);
        else activeSignal.addEventListener('abort', () => reject(activeSignal.reason), { once: true });
      });
    } else await sleep({ milliseconds: completionLeaseMs, signal: activeSignal });
  } catch (error) {
    if (!established && !signal.aborted && confirmation.signal.aborted && error === confirmation.signal.reason)
      throw new RestartDiscoveryError();
    throw error;
  } finally {
    stop.abort();
    confirmation.dispose();
    await Promise.allSettled(jobs);
    channel.dispose();
  }
}

/** Waiting for a peer and human comparison have no expiry; only automatic candidate confirmation does. */
export async function startPinnedConnection({ role, identity, expectedPeer, code, endpoint, signal, confirmationTimeoutMs,
  completionLeaseMs, intervalMs, purpose, verifyPeer }: {
  role: NaidanPipingRole | undefined; identity: NaidanPipingIdentity; expectedPeer: Uint8Array | undefined;
  verifyPeer: NaidanPipingPeerVerifier | undefined; code: string; endpoint: FiniteTransport; signal: AbortSignal;
  confirmationTimeoutMs: number; completionLeaseMs: number | undefined; intervalMs: number; purpose: Uint8Array;
}): Promise<PinnedConnectionTask> {
  for (const value of [confirmationTimeoutMs, completionLeaseMs, intervalMs])
    requireValue({ condition: value === undefined || (Number.isInteger(value) && value > 0 && value <= 2147483647), message: 'Connection timer duration' });
  const purposeBytes = ownBytes({ bytes: purpose, maxBytes: 256 });
  const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 });
  requireValue({ condition: pin?.length === 32 || (pin === undefined && verifyPeer !== undefined), message: 'Expected pin or explicit peer comparison required' });
  const localIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  signal.throwIfAborted();
  const room = await rendezvousRoom({ code, origin: endpoint.origin });
  signal.throwIfAborted();
  const owner = crypto.getRandomValues(new Uint8Array(16));
  const ready = Promise.withResolvers<NaidanPipingKeyContext>();
  void ready.promise.catch(() => {});
  const completion = (async () => {
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          const { channel, confirmation } = await discoverCandidate({ role, room, endpoint, owner, signal,
            confirmationTimeoutMs, intervalMs });
          await runCandidate({ channel, confirmation, identity: localIdentity, expectedPeer: pin, verifyPeer, purpose: purposeBytes,
            endpoint, signal, completionLeaseMs, intervalMs, onReady: ({ keys }) => ready.resolve(keys) });
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RestartDiscoveryError)) throw error;
          await sleep({ milliseconds: intervalMs, signal });
        }
      }
    } catch (error) {
      ready.reject(error); throw error;
    } finally {
      owner.fill(0); room.fill(0);
    }
  })();
  void completion.catch(() => {});
  return { ready: ready.promise, completion };
}

export const TEST_ONLY = {
};
