import { equalBytes, joinBytes, ownBytes, requireValue } from './bytes';
import { readOffer, runHandshakeAttempt } from './finite-handshake';
import type { HandshakeResult } from './finite-handshake';
import type { FiniteTransfer } from './finite-transfer';
import { HandshakeResponseUnconfirmedError, PipingRetirementError } from './lifetime';
import type { NaidanPipingIdentity } from './noise-xx';
import { pinnedPeerRoutes } from './peer-routes';
import { encodeProtocolHeader, inspectProtocolHeader } from './protocol-header';
import { isInitiator } from './role';

export type PreparedPinnedKeys = {
  readonly kind: 'candidate';
  readonly peerPublicHandshakeData: Uint8Array;
  assertAvailable(): void;
  finish(): Promise<HandshakeResult>;
  dispose(): Promise<void>;
};
class SameConnection extends Error {}

/** One contact attempt, not a reconnect supervisor. The suspended key exchange
 * keeps its split cipher/nonce ownership; finishing never restarts Noise. */
export async function preparePinnedKeys({ endpoint, identity, expectedPeer, purpose, signal: parent, responseTimeoutMs, publicHandshakeData, handshakeData, heldContext }: {
  endpoint: FiniteTransfer; identity: NaidanPipingIdentity; expectedPeer: Uint8Array; purpose: string; signal: AbortSignal;
  responseTimeoutMs: number; publicHandshakeData: Uint8Array; handshakeData: Uint8Array; heldContext: Uint8Array | undefined;
}): Promise<PreparedPinnedKeys | { kind: 'same-connection' }> {
  const held = heldContext === undefined ? undefined : ownBytes({ bytes: heldContext, maxBytes: 32 });
  requireValue({ condition: held === undefined || held.length === 32, message: 'Contact context size' });
  const publicData = ownBytes({ bytes: publicHandshakeData, maxBytes: 256 });
  const privateData = ownBytes({ bytes: handshakeData, maxBytes: 16384 });
  const local = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  const peer = ownBytes({ bytes: expectedPeer, maxBytes: 32 });
  const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal]);
  const offered = Promise.withResolvers<PreparedPinnedKeys | { kind: 'same-connection' }>();
  const gate = Promise.withResolvers<void>(); void gate.promise.catch(() => {});
  const abortGate = () => gate.reject(signal.reason);
  signal.addEventListener('abort', abortGate, { once: true }); if (signal.aborted) abortGate();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = ({ milliseconds = Math.min(15000, responseTimeoutMs * 3) }: { milliseconds?: number } = {}) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => stop.abort(new HandshakeResponseUnconfirmedError({ stage: 'status' })), milliseconds);
  };
  const receiveEntry = ({ route, maximum, idle }: { route: string; maximum: number; idle: boolean }) => endpoint.read({
    route,
    maximum,
    signal,
    timeoutMs: idle ? null : undefined,
    consume: async ({ body }) => {
      deadline({ milliseconds: Math.min(5000, responseTimeoutMs) });
      return body.all();
    },
  });
  let state: 'waiting' | 'prepared' | 'finishing' | 'disposed' = 'waiting';
  let advertised = new Uint8Array();
  const task = (async (): Promise<HandshakeResult> => {
    const routes = await pinnedPeerRoutes({ identity: local, expectedPeer: peer, origin: endpoint.origin, purpose, signal });
    signal.throwIfAborted();
    let incoming: ReturnType<typeof readOffer> | undefined;
    if (isInitiator({ role: routes.role })) {
      if (held) {
        const bytes = await receiveEntry({ route: routes.knockPath, maximum: 14, idle: true });
        requireValue({ condition: bytes.length === 14 && bytes[13] === 0x23 && inspectProtocolHeader({ bytes, maxBytes: 14 }).kind === 'supported', message: 'Invalid connection KNOCK' });
      }
    } else {
      const knockStop = new AbortController();
      const knocking = held ? undefined : endpoint.send({ route: routes.knockPath, bytes: joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([0x23])] }), signal: AbortSignal.any([signal, knockStop.signal]) });
      void knocking?.catch(() => {});
      let failure: { error: unknown } | undefined;
      try {
        incoming = readOffer({ bytes: await receiveEntry({ route: routes.offerPath, maximum: 78, idle: held !== undefined }) });
      } catch (error) {
        failure = { error };
      }
      knockStop.abort();
      try {
        await knocking;
      } catch (error) {
        if (error instanceof PipingRetirementError) throw error;
      }
      if (failure) throw failure.error;
    }
    deadline();
    return runHandshakeAttempt({
      material: { entry: routes.offerPath, secret: routes.handshakeRouteKey },
      role: routes.role,
      incoming,
      endpoint,
      identity: local,
      expectedPeer: peer,
      verifyPeer: undefined,
      signal,
      responseTimeoutMs,
      data: privateData,
      contact: {
        heldContext: held,
        publicHandshakeData: publicData,
        confirm: async ({ peerHeldContext, peerPublicHandshakeData, signal: authenticatedSignal }) => {
          authenticatedSignal.throwIfAborted();
          if (held && peerHeldContext && equalBytes({ left: held, right: peerHeldContext })) throw new SameConnection();
          advertised = peerPublicHandshakeData.slice(); state = 'prepared'; deadline();
          offered.resolve({
            kind: 'candidate',
            assertAvailable: () => {
              requireValue({ condition: state === 'prepared', message: 'Prepared contact already consumed' }); signal.throwIfAborted();
            },
            get peerPublicHandshakeData() {
              return advertised.slice();
            },
            finish: async () => {
              requireValue({ condition: state === 'prepared', message: 'Prepared contact already consumed' });
              state = 'finishing'; signal.throwIfAborted(); gate.resolve();
              const result = await task;
              const peerPublicHandshakeData = advertised.slice(); advertised.fill(0);
              return { ...result, peerPublicHandshakeData };
            },
            dispose: async () => {
              requireValue({ condition: state === 'prepared', message: 'Prepared contact already consumed' });
              state = 'disposed'; stop.abort(new Error('Contact discarded'));
              try {
                await task;
              } catch (error) {
                if (error instanceof PipingRetirementError) throw error;
              }
              advertised.fill(0);
            },
          });
          await gate.promise; authenticatedSignal.throwIfAborted();
        },
      },
    });
  })().finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abortGate);
    held?.fill(0); publicData.fill(0); privateData.fill(0); peer.fill(0);
  });
  void task.catch(error => {
    if (error instanceof SameConnection) offered.resolve({ kind: 'same-connection' });
    else offered.reject(error);
  });
  return offered.promise;
}

export async function connectPinnedKeys({ endpoint, identity, expectedPeer, purpose, signal, responseTimeoutMs, publicHandshakeData, handshakeData }: {
  endpoint: FiniteTransfer; identity: NaidanPipingIdentity; expectedPeer: Uint8Array; purpose: string; signal: AbortSignal; responseTimeoutMs: number;
  publicHandshakeData: Uint8Array; handshakeData: Uint8Array;
}): Promise<HandshakeResult> {
  const prepared = await preparePinnedKeys({ endpoint, identity, expectedPeer, purpose, signal, responseTimeoutMs, publicHandshakeData, handshakeData, heldContext: undefined });
  switch (prepared.kind) {
  case 'candidate': return prepared.finish();
  case 'same-connection': throw new Error('An empty contact cannot retain a connection');
  default: { const exhaustive: never = prepared; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
