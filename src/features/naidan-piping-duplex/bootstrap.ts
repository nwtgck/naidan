import { PipingRetirementError } from './lifetime';
import { encodeDiscovery, encodeHint, inspectDiscovery, selectedChallenge } from './envelope';
import { equalBytes, joinBytes, ownBytes } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, Deadline, sleep } from '@/features/naidan-piping-duplex/finite';
import type { FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { RendezvousChannel, rendezvousRoute } from '@/features/naidan-piping-duplex/rendezvous';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';

type Discovery = { kind: 'response'; attemptR: Uint8Array; reply: Uint8Array; publicData: Uint8Array } | { kind: 'receive-offer' };
/** Bounded, unverified observations only. Never a terminal failure or peer identity claim. */
export class DiscoveryObservations {
  private latest: { kind: string; version: number | undefined } | undefined;
  private lastHint: Uint8Array | undefined;
  private nextHintAt = 0;
  observe({ kind, version }: { kind: string; version?: number }): void {
    if (this.latest?.kind !== kind || this.latest.version !== version) this.latest = { kind, version };
  }
  mayHint({ attemptI, intervalMs }: { attemptI: Uint8Array; intervalMs: number }): boolean {
    const now = performance.now();
    if (now < this.nextHintAt || (this.lastHint && equalBytes({ left: this.lastHint, right: attemptI }))) return false;
    this.lastHint = attemptI.slice(); this.nextHintAt = now + intervalMs; return true;
  }
}

export class RestartDiscoveryError extends Error {
  constructor() {
    super('Restart rendezvous discovery');
  }
}

/** The stable prefix rejects our own delayed offers without an unbounded attempt ledger. */
function freshAttempt({ owner }: { owner: Uint8Array }): Uint8Array {
  return joinBytes({ parts: [owner, crypto.getRandomValues(new Uint8Array(16))] });
}
/** A finite phase has one POST owner. It joins every request before returning a new phase. */
async function exchange<T>({ endpoint, send, receiveRoute, accept, duplicateSender, signal, intervalMs, sent }: {
  endpoint: FiniteTransport; send: { route: string; bytes: Uint8Array } | undefined; receiveRoute: string;
  accept({ bytes }: { bytes: Uint8Array }): T | undefined; duplicateSender: (() => T) | undefined;
  signal: AbortSignal; intervalMs: number; sent?: () => T;
}): Promise<T> {
  signal.throwIfAborted();
  const stop = new AbortController();
  const result = Promise.withResolvers<T>();
  const retirementFailures: PipingRetirementError[] = [];
  let logicalFailure: { error: unknown } | undefined;
  let accepted: { value: T } | undefined;
  void result.promise.catch(() => {});
  const forward = () => {
    result.reject(signal.reason); stop.abort(signal.reason);
  };
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) forward();
  const guarded = async ({ task }: { task(): Promise<void> }): Promise<void> => {
    try {
      await task();
    } catch (error) {
      if (error instanceof PipingRetirementError) retirementFailures.push(error);
      result.reject(error); stop.abort(error);
    }
  };
  const sendLoop = async () => {
    if (!send) return;
    while (!stop.signal.aborted) {
      try {
        await endpoint.send({ ...send, signal: stop.signal });
      } catch (error) {
        if (error instanceof PipingRetirementError) throw error;
        stop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || (!sent && error.kind === 'fatal')) throw error;
        if (error.kind === 'waiting-sender' && duplicateSender) {
          result.resolve(duplicateSender()); return;
        }
        // Public discovery must never repair/drain somebody else's offer or response.
      }
      if (sent) {
        result.resolve(sent()); return;
      }
      await sleep({ milliseconds: intervalMs, signal: stop.signal });
    }
  };
  const receiveLoop = async () => {
    while (!stop.signal.aborted) {
      try {
        const accepted = accept({ bytes: await endpoint.receive({ route: receiveRoute, signal: stop.signal }) });
        if (accepted !== undefined) {
          result.resolve(accepted); return;
        }
      } catch (error) {
        if (error instanceof PipingRetirementError) throw error;
        stop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
      }
      await sleep({ milliseconds: intervalMs, signal: stop.signal });
    }
  };
  const jobs = [guarded({ task: sendLoop }), guarded({ task: receiveLoop })];
  try {
    accepted = { value: await result.promise };
  } catch (error) {
    logicalFailure = { error };
  } finally {
    stop.abort();
    await Promise.allSettled(jobs);
    signal.removeEventListener('abort', forward);
  }
  if (retirementFailures.length) throw new PipingRetirementError({ cause: retirementFailures[0], logicalError: logicalFailure?.error });
  if (logicalFailure) throw logicalFailure.error;
  if (!accepted) throw new Error('Discovery phase produced no result');
  signal.throwIfAborted();
  return accepted.value;
}

/** Offers are public rendezvous; the selected pair still requires Noise and peer authentication. */
export async function discoverCandidate({ role, room, endpoint, owner, signal, confirmationTimeoutMs, intervalMs,
  publicData = new Uint8Array(), observations = new DiscoveryObservations() }: {
  role: NaidanPipingRole | undefined; room: Uint8Array; endpoint: FiniteTransport; owner: Uint8Array;
  signal: AbortSignal; confirmationTimeoutMs: number; intervalMs: number; publicData?: Uint8Array; observations?: DiscoveryObservations;
}): Promise<{ channel: RendezvousChannel; confirmation: Deadline; peerPublicData: Uint8Array }> {
  const localData = ownBytes({ bytes: publicData, maxBytes: 256 });
  const offerRoute = await rendezvousRoute({ room, kind: 'offer', attempts: [] }); signal.throwIfAborted();
  const attempt = freshAttempt({ owner });
  const localOffer = encodeDiscovery({ kind: 'offer', attemptI: attempt, publicData: localData });
  let discovery: Discovery;
  switch (role) {
  case undefined: case 'initiator': {
    const replyRoute = await rendezvousRoute({ room, kind: 'reply', attempts: [attempt] }); signal.throwIfAborted();
    discovery = await exchange<Discovery>({
      endpoint,
      send: { route: offerRoute, bytes: localOffer },
      receiveRoute: replyRoute,
      accept: ({ bytes }) => {
        const packet = inspectDiscovery({ bytes });
        if ((packet.kind === 'hint' || packet.kind === 'unsupported-reply') && equalBytes({ left: packet.attemptI, right: attempt })) observations.observe({ kind: packet.kind, version: packet.version });
        if (packet.kind !== 'reply' || !equalBytes({ left: packet.attemptI, right: attempt })) return undefined;
        return { kind: 'response', attemptR: packet.attemptR, reply: packet.bytes, publicData: packet.publicData };
      },
      duplicateSender: role === undefined ? () => ({ kind: 'receive-offer' }) : undefined,
      signal,
      intervalMs,
    });
    break;
  }
  case 'responder': discovery = { kind: 'receive-offer' }; break;
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
  switch (discovery.kind) {
  case 'response': {
    const confirmation = new Deadline({ parent: signal, milliseconds: confirmationTimeoutMs });
    let channel: RendezvousChannel | undefined;
    try {
      channel = await RendezvousChannel.create({
        role: 'initiator',
        room,
        attemptI: attempt,
        attemptR: discovery.attemptR,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        offer: localOffer,
        reply: discovery.reply,
      });
      confirmation.signal.throwIfAborted(); return { channel, confirmation, peerPublicData: discovery.publicData };
    } catch (error) {
      channel?.dispose(); const expired = confirmation.signal.aborted && !signal.aborted && error === confirmation.signal.reason;
      confirmation.dispose(); if (expired) throw new RestartDiscoveryError(); throw error;
    }
  }
  case 'receive-offer': {
    type OfferResult = { kind: 'offer'; attemptI: Uint8Array; bytes: Uint8Array; publicData: Uint8Array } | { kind: 'hint'; attemptI: Uint8Array } | { kind: 'hint-sent' };
    const accept = ({ bytes, answer }: { bytes: Uint8Array; answer: boolean }): OfferResult | undefined => {
      const packet = inspectDiscovery({ bytes });
      if (packet.kind !== 'offer' && packet.kind !== 'unsupported-offer') return undefined;
      if (equalBytes({ left: packet.attemptI.subarray(0, 16), right: owner })) {
        if (role === undefined) throw new RestartDiscoveryError(); return undefined;
      }
      switch (packet.kind) {
      case 'offer': return packet;
      case 'unsupported-offer':
        observations.observe({ kind: 'unsupported-protocol-version', version: packet.version });
        if (answer && observations.mayHint({ attemptI: packet.attemptI, intervalMs })) return { kind: 'hint', attemptI: packet.attemptI };
        return undefined;
      default: { const exhaustive: never = packet; throw new Error(String(exhaustive)); }
      }
    };
    let offer: Extract<OfferResult, { kind: 'offer' }>;
    receiving: for (;;) {
      let received = await exchange<OfferResult>({
        endpoint,
        send: undefined,
        receiveRoute: offerRoute,
        accept: ({ bytes }) => accept({ bytes, answer: true }),
        duplicateSender: undefined,
        signal,
        intervalMs,
      });
      switch (received.kind) {
      case 'offer': offer = received; break receiving;
      case 'hint-sent': break;
      case 'hint': {
        const route = await rendezvousRoute({ room, kind: 'reply', attempts: [received.attemptI] }); signal.throwIfAborted();
        // One finite POST, while a compatible offer can still win. Every phase
        // joins both owners before returning; duplicates never create a queue.
        received = await exchange<OfferResult>({
          endpoint,
          send: { route, bytes: encodeHint({ attemptI: received.attemptI }) },
          receiveRoute: offerRoute,
          accept: ({ bytes }) => accept({ bytes, answer: false }),
          duplicateSender: undefined,
          signal,
          intervalMs,
          sent: () => ({ kind: 'hint-sent' }),
        });
        break;
      }
      default: { const exhaustive: never = received; throw new Error(String(exhaustive)); }
      }
      switch (received.kind) {
      case 'offer': offer = received; break receiving;
      case 'hint': case 'hint-sent': break;
      default: { const exhaustive: never = received; throw new Error(String(exhaustive)); }
      }
      await sleep({ milliseconds: intervalMs, signal });
    }
    const confirmation = new Deadline({ parent: signal, milliseconds: confirmationTimeoutMs });
    let channel: RendezvousChannel | undefined;
    try {
      const attemptI = offer.attemptI, attemptR = freshAttempt({ owner });
      const replyRoute = await rendezvousRoute({ room, kind: 'reply', attempts: [attemptI] });
      const selectRoute = await rendezvousRoute({ room, kind: 'initiator', attempts: [attemptI, attemptR] });
      const reply = encodeDiscovery({ kind: 'reply', attemptI, attemptR, publicData: localData });
      const selected = await exchange({
        endpoint,
        send: { route: replyRoute, bytes: reply },
        receiveRoute: selectRoute,
        accept: ({ bytes }) => selectedChallenge({ bytes, attemptI, attemptR }),
        duplicateSender: undefined,
        signal: confirmation.signal,
        intervalMs,
      });
      channel = await RendezvousChannel.create({ role: 'responder', room, attemptI, attemptR, challenge: selected, offer: offer.bytes, reply });
      confirmation.signal.throwIfAborted();
      // Reconstruct only our selection acknowledgement, never remote OFFER/REPLY binding bytes.
      const selection = channel.snapshot(); selection[46] = 1;
      channel.accept({ bytes: selection });
      return { channel, confirmation, peerPublicData: offer.publicData };
    } catch (error) {
      channel?.dispose(); const expired = confirmation.signal.aborted && !signal.aborted && error === confirmation.signal.reason;
      confirmation.dispose(); if (expired) throw new RestartDiscoveryError(); throw error;
    }
  }
  default: { const exhaustive: never = discovery; throw new Error(String(exhaustive)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
