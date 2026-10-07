import { z } from 'zod';
import { equalBytes, joinBytes, ownBytes } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, Deadline, sleep } from '@/features/naidan-piping-duplex/finite';
import type { FiniteTransport } from '@/features/naidan-piping-duplex/finite';
import { RendezvousChannel, rendezvousRoute } from '@/features/naidan-piping-duplex/rendezvous';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';

const attemptSchema = z.instanceof(Uint8Array).refine(bytes => bytes.length === 32 && bytes.some(Boolean));
const offerSchema = z.object({ version: z.literal(2), kind: z.literal(1), attemptI: attemptSchema });
const responseSchema = z.object({ version: z.literal(2), kind: z.literal(2), attemptI: attemptSchema, attemptR: attemptSchema });
type Discovery = { kind: 'response'; attemptR: Uint8Array } | { kind: 'receive-offer' };

export class RestartDiscoveryError extends Error {
  constructor() {
    super('Restart rendezvous discovery');
  }
}

/** The stable prefix rejects our own delayed offers without an unbounded attempt ledger. */
function freshAttempt({ owner }: { owner: Uint8Array }): Uint8Array {
  return joinBytes({ parts: [owner, crypto.getRandomValues(new Uint8Array(16))] });
}
function receiveOffer({ bytes, owner }: { bytes: Uint8Array; owner: Uint8Array }): { kind: 'self' } | { kind: 'peer'; attemptI: Uint8Array } | undefined {
  if (bytes.length !== 34) return undefined;
  const result = offerSchema.safeParse({ version: bytes[0], kind: bytes[1], attemptI: bytes.slice(2) });
  if (!result.success) return undefined;
  if (equalBytes({ left: result.data.attemptI.subarray(0, 16), right: owner })) return { kind: 'self' };
  return { kind: 'peer', attemptI: result.data.attemptI };
}
function receiveResponse({ bytes, attemptI }: { bytes: Uint8Array; attemptI: Uint8Array }): Discovery | undefined {
  if (bytes.length !== 66) return undefined;
  const result = responseSchema.safeParse({ version: bytes[0], kind: bytes[1], attemptI: bytes.slice(2, 34), attemptR: bytes.slice(34) });
  if (!result.success || !equalBytes({ left: result.data.attemptI, right: attemptI })) return undefined;
  return { kind: 'response', attemptR: result.data.attemptR };
}

/** A finite phase has one POST owner. It joins every request before returning a new phase. */
async function exchange<T>({ endpoint, send, receiveRoute, accept, duplicateSender, signal, intervalMs }: {
  endpoint: FiniteTransport; send: { route: string; bytes: Uint8Array } | undefined; receiveRoute: string;
  accept({ bytes }: { bytes: Uint8Array }): T | undefined; duplicateSender: (() => T) | undefined;
  signal: AbortSignal; intervalMs: number;
}): Promise<T> {
  signal.throwIfAborted();
  const stop = new AbortController();
  const result = Promise.withResolvers<T>();
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
      result.reject(error); stop.abort(error);
    }
  };
  const sendLoop = async () => {
    if (!send) return;
    while (!stop.signal.aborted) {
      try {
        await endpoint.send({ ...send, signal: stop.signal });
      } catch (error) {
        stop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
        if (error.kind === 'waiting-sender' && duplicateSender) {
          result.resolve(duplicateSender()); return;
        }
        // Public discovery must never repair/drain somebody else's offer or response.
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
        stop.signal.throwIfAborted();
        if (!(error instanceof AttemptError) || error.kind === 'fatal') throw error;
      }
      await sleep({ milliseconds: intervalMs, signal: stop.signal });
    }
  };
  const jobs = [guarded({ task: sendLoop }), guarded({ task: receiveLoop })];
  try {
    return await result.promise;
  } finally {
    stop.abort();
    await Promise.allSettled(jobs);
    signal.removeEventListener('abort', forward);
  }
}

/** Offers are public rendezvous; the selected pair still requires Noise and peer authentication. */
export async function discoverCandidate({ role, room, endpoint, owner, signal, confirmationTimeoutMs, intervalMs }: {
  role: NaidanPipingRole | undefined; room: Uint8Array; endpoint: FiniteTransport; owner: Uint8Array;
  signal: AbortSignal; confirmationTimeoutMs: number; intervalMs: number;
}): Promise<{ channel: RendezvousChannel; confirmation: Deadline }> {
  const offerRoute = await rendezvousRoute({ room, kind: 'offer', attempts: [] });
  signal.throwIfAborted();
  const attempt = freshAttempt({ owner });
  let discovery: Discovery;
  switch (role) {
  case undefined: case 'initiator': {
    const reply = await rendezvousRoute({ room, kind: 'reply', attempts: [attempt] });
    signal.throwIfAborted();
    discovery = await exchange({ endpoint, send: { route: offerRoute, bytes: joinBytes({ parts: [new Uint8Array([2, 1]), attempt] }) },
      receiveRoute: reply, accept: ({ bytes }) => receiveResponse({ bytes, attemptI: attempt }),
      duplicateSender: role === undefined ? () => ({ kind: 'receive-offer' }) : undefined, signal, intervalMs });
    break;
  }
  case 'responder': discovery = { kind: 'receive-offer' }; break;
  default: { const unreachable: never = role; throw new Error(`Unknown discovery role: ${unreachable}`); }
  }
  switch (discovery.kind) {
  case 'response': {
    const confirmation = new Deadline({ parent: signal, milliseconds: confirmationTimeoutMs });
    let channel: RendezvousChannel | undefined;
    try {
      channel = await RendezvousChannel.create({ role: 'initiator', room, attemptI: attempt, attemptR: discovery.attemptR,
        challenge: crypto.getRandomValues(new Uint8Array(32)) });
      confirmation.signal.throwIfAborted();
      return { channel, confirmation };
    } catch (error) {
      channel?.dispose();
      const expired = confirmation.signal.aborted && !signal.aborted && error === confirmation.signal.reason;
      confirmation.dispose();
      if (expired) throw new RestartDiscoveryError();
      throw error;
    }
  }
  case 'receive-offer': {
    const attemptI = await exchange({ endpoint, send: undefined, receiveRoute: offerRoute,
      accept: ({ bytes }) => {
        const offer = receiveOffer({ bytes, owner });
        if (!offer) return undefined;
        switch (offer.kind) {
        case 'peer': return offer.attemptI;
        case 'self':
          // Local request retirement does not guarantee immediate server release.
          // Consuming our delayed OFFER frees discovery for a fresh POST; staying
          // in receive-only mode could leave both automatic peers waiting forever.
          if (role === undefined) throw new RestartDiscoveryError();
          return undefined;
        default: { const unreachable: never = offer; throw new Error(String(unreachable)); }
        }
      }, duplicateSender: undefined, signal, intervalMs });
    const confirmation = new Deadline({ parent: signal, milliseconds: confirmationTimeoutMs });
    let channel: RendezvousChannel | undefined;
    try {
      const attemptR = freshAttempt({ owner });
      const reply = await rendezvousRoute({ room, kind: 'reply', attempts: [attemptI] });
      const selectRoute = await rendezvousRoute({ room, kind: 'initiator', attempts: [attemptI, attemptR] });
      const selected = await exchange({ endpoint, send: { route: reply, bytes: joinBytes({ parts: [new Uint8Array([2, 2]), attemptI, attemptR] }) },
        receiveRoute: selectRoute, accept: ({ bytes }) => {
          // SELECT is a challenge followed by the empty initiator journal for this exact pair.
          if (bytes.length !== 99 || !bytes.subarray(0, 32).some(Boolean) || bytes[32] !== 1 || bytes[33] !== 1 || bytes[98] !== 0 ||
            !equalBytes({ left: bytes.subarray(34, 66), right: attemptI }) || !equalBytes({ left: bytes.subarray(66, 98), right: attemptR })) return undefined;
          return ownBytes({ bytes, maxBytes: 99 });
        }, duplicateSender: undefined, signal: confirmation.signal, intervalMs });
      channel = await RendezvousChannel.create({ role: 'responder', room, attemptI, attemptR, challenge: selected.subarray(0, 32) });
      confirmation.signal.throwIfAborted();
      channel.accept({ bytes: selected });
      return { channel, confirmation };
    } catch (error) {
      channel?.dispose();
      const expired = confirmation.signal.aborted && !signal.aborted && error === confirmation.signal.reason;
      confirmation.dispose();
      if (expired) throw new RestartDiscoveryError();
      throw error;
    }
  }
  default: { const unreachable: never = discovery; throw new Error(`Unknown discovery: ${unreachable}`); }
  }
}

export const TEST_ONLY = {
};
