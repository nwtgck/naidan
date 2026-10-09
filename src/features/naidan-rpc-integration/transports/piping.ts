import { PipingStatusError } from '@/features/naidan-piping-duplex/finite-transfer';
import { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';
import { RpcPeerClosedError } from '@/features/naidan-rpc-integration/runtime/link-lifecycle';
import type { RpcLink } from '@/features/naidan-rpc-integration/runtime/manager';
import { createRpcProtocolAdvertisement, validateRpcProtocolAdvertisement, NaidanRpcProtocolError } from '@/features/naidan-rpc';
import { PipingRetirementError } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { validateRpcTransport } from '@/00-storage/service/naidan-rpc';
import { encodePeerKey, decodePeerKey } from '@/features/naidan-rpc-integration/runtime/identity';
import { normalizeRpcPairingCode } from '@/features/naidan-rpc-integration/runtime/pairing-code';

/** HTTP status is a relay configuration observation, never peer authentication. */
function terminalRelayFailure({ error }: { error: unknown }): boolean {
  if (!(error instanceof PipingStatusError)) return false;
  switch (error.kind) {
  case 'fatal': return true;
  case 'waiting-sender': case 'waiting-receiver': case 'transient': case 'established': return false;
  default: { const exhaustive: never = error.kind; throw new Error(String(exhaustive)); }
  }
}
/** A failed connection may be retried; its RPC calls are never replayed. */
export class RpcTransportInterruptedError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('RPC transport interrupted', { cause }); this.name = 'RpcTransportInterruptedError';
  }
}
const authenticatedProtocolFailures = new WeakSet<NaidanRpcProtocolError>();
/** Only errors produced at this adapter's authenticated boundary get this label. */
export function describePipingRpcProtocolFailure({ error }: { error: unknown }): string | undefined {
  const original = error instanceof PipingRetirementError ? error.logicalError : error;
  return original instanceof NaidanRpcProtocolError && authenticatedProtocolFailures.has(original) ? original.message : undefined;
}
async function acceptRpcConnection({ connection, signal }: { connection: NaidanPipingDuplexSession; signal: AbortSignal }): Promise<NaidanPipingDuplexSession> {
  try {
    signal.throwIfAborted();
    const bytes = connection.peerPublicHandshakeData;
    try {
      validateRpcProtocolAdvertisement({ bytes });
    } catch (error) {
      if (error instanceof NaidanRpcProtocolError) authenticatedProtocolFailures.add(error);
      throw error;
    }
    signal.throwIfAborted(); return connection;
  } catch (error) {
    const original = signal.aborted ? signal.reason : error;
    let cleanup: { error: unknown } | undefined;
    try {
      connection.abort({ reason: 'RPC protocol initialization rejected' });
    } catch (failure) {
      cleanup = { error: failure };
    }
    try {
      await connection.closed;
    } catch (failure) {
      cleanup ??= { error: failure };
    }
    if (cleanup) throw new PipingRetirementError({ cause: cleanup.error, logicalError: original });
    throw original;
  }
}

export async function openPipingRpc({ settings, identity, peerKey, code, verifyPeer, signal }: {
  settings: NaidanRpcTransportSettings,
  identity: NaidanPipingIdentity,
  peerKey: string | undefined,
  code: string | undefined,
  verifyPeer: NaidanPipingPeerVerifier | undefined,
  signal: AbortSignal,
}): Promise<RpcLink> {
  const transport = validateRpcTransport({ value: settings });
  const piping = {
    baseUrl: transport.serverUrl,
    policy: transport.serverUrl.startsWith('https:') ? 'https-only' as const : 'allow-loopback-http' as const,
    headers: transport.headers.map(({ name, value }) => ({ name, value })),
    requestTimeoutMs: 120000,
    handshakeResponseTimeoutMs: 75_000,
  };
  const expectedPeer = peerKey === undefined ? undefined : decodePeerKey({ value: peerKey });
  if (peerKey !== undefined && encodePeerKey({ bytes: identity.publicKey }) === peerKey) throw new Error('Cannot connect to this device itself');
  if (peerKey === undefined && (code === undefined || !verifyPeer)) throw new Error('Pairing requires a shared code and explicit verifier');
  const normalized = peerKey === undefined ? normalizeRpcPairingCode({ code: code! }) : undefined;
  signal.throwIfAborted();
  const physical = new AbortController();
  const forward = () => physical.abort(signal.reason);
  const detach = () => signal.removeEventListener('abort', forward);
  signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
  const wrap = ({ accepted, detach }: { accepted: NaidanPipingDuplexSession; detach(): void }): RpcLink => {
    const ended = accepted.ended.then(outcome => {
      switch (outcome.kind) {
      case 'peer-closed': return { error: new RpcPeerClosedError() };
      case 'authenticated-protocol-error': return { error: outcome.error };
      case 'local-stop': case 'response-unconfirmed': case 'record-exhausted':
      case 'transport-fatal':
        if (terminalRelayFailure({ error: outcome.error })) return { error: outcome.error };
        return { error: new RpcTransportInterruptedError({ cause: outcome.error }) };
      default: { const exhaustive: never = outcome.kind; throw new Error(String(exhaustive)); }
      }
    });
    void ended.catch(() => {});
    const closed = accepted.closed.finally(detach); void closed.catch(() => {});
    // The verified pairing connection is itself usable. No second handshake
    // races the other peer's READY publication or requires extra HTTP lanes.
    return {
      peerIdentity: accepted.peerIdentity,
      incomingStreams: accepted.incomingStreams,
      closed,
      ended,
      openStream: ({ signal }) => accepted.openStream({ signal }),
      abort: ({ reason }) => accepted.abort({ reason }),
      session: {
        adopt: detach,
        prepareReplacement: async ({ signal: ownerSignal }) => {
          const nextPhysical = new AbortController();
          const forwardNext = () => nextPhysical.abort(ownerSignal.reason);
          const detachNext = () => ownerSignal.removeEventListener('abort', forwardNext);
          ownerSignal.addEventListener('abort', forwardNext, { once: true }); if (ownerSignal.aborted) forwardNext();
          let prepared: Awaited<ReturnType<typeof NaidanPipingDuplexSession.preparePinnedContact>> | undefined;
          try {
            prepared = await NaidanPipingDuplexSession.preparePinnedContact({
              piping,
              identity,
              expectedPeer: accepted.peerIdentity,
              purpose: 'naidan-rpc/registered-peer/v1',
              publicHandshakeData: createRpcProtocolAdvertisement(),
              heldContext: accepted.contextId,
              signal: nextPhysical.signal,
            });
            switch (prepared.kind) {
            case 'same-connection': detachNext(); return undefined;
            case 'candidate': break;
            default: { const exhaustive: never = prepared; throw new Error(String(exhaustive)); }
            }
            const bytes = prepared.peerPublicHandshakeData;
            try {
              validateRpcProtocolAdvertisement({ bytes });
            } catch (error) {
              if (error instanceof NaidanRpcProtocolError) authenticatedProtocolFailures.add(error);
              throw error;
            }
            ownerSignal.throwIfAborted(); prepared.assertAvailable();
            const candidate = prepared;
            let consumed = false;
            const claim = () => {
              if (consumed) throw new Error('RPC contact already consumed');
              consumed = true;
            };
            return {
              assertAvailable: () => {
                if (consumed) throw new Error('RPC contact already consumed');
                ownerSignal.throwIfAborted(); candidate.assertAvailable();
              },
              dispose: async () => {
                claim(); detachNext(); nextPhysical.abort(); await candidate.dispose();
              },
              finish: async () => {
                claim();
                try {
                  const next = await candidate.finish();
                  const verified = await acceptRpcConnection({ connection: next, signal: nextPhysical.signal });
                  return wrap({ accepted: verified, detach: detachNext });
                } catch (error) {
                  detachNext(); nextPhysical.abort(error); throw error;
                }
              },
            };
          } catch (error) {
            detachNext(); nextPhysical.abort(error);
            if (prepared) {
              switch (prepared.kind) {
              case 'candidate': await prepared.dispose(); break;
              case 'same-connection': break;
              default: { const exhaustive: never = prepared; throw new Error(String(exhaustive)); }
              }
            }
            throw error;
          }
        },
        close: () => accepted.close({ noticeTimeoutMs: 1000, signal: undefined }).then(() => {}),
        get health() {
          return accepted.health;
        },
        subscribeHealth: ({ listener }) => accepted.subscribeHealth({ listener }),
      },
    };
  };
  let connection: NaidanPipingDuplexSession | undefined;
  try {
    try {
      if (expectedPeer) {
        connection = await NaidanPipingDuplexSession.connectPinned({
          piping,
          identity,
          expectedPeer,
          purpose: 'naidan-rpc/registered-peer/v1',
          publicHandshakeData: createRpcProtocolAdvertisement(),
          signal: physical.signal,
        });
      } else {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['naidan-peer-rpc-pairing/v1', normalized]))));
        physical.signal.throwIfAborted();
        const rendezvousCode = 'peer-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        connection = await NaidanPipingDuplexSession.pair({ piping, code: rendezvousCode, identity, verifyPeer: verifyPeer!, signal: physical.signal, publicHandshakeData: createRpcProtocolAdvertisement() });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PipingRetirementError || terminalRelayFailure({ error })) throw error;
      throw new RpcTransportInterruptedError({ cause: error });
    }
    const accepted = await acceptRpcConnection({ connection, signal });
    return wrap({ accepted, detach });
  } catch (error) {
    detach(); physical.abort(error);
    if (connection) {
      try {
        await connection.closed;
      } catch (cause) {
        if (error instanceof PipingRetirementError) throw error;
        throw new PipingRetirementError({ cause, logicalError: error });
      }
    }
    throw error;
  }
}
export const TEST_ONLY = {
};
