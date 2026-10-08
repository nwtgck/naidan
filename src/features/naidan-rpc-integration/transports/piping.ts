import { openPersistentPipingRpc } from './persistent-piping';
import type { RpcLink } from '@/features/naidan-rpc-integration/runtime/manager';
import { createRpcProtocolAdvertisement, validateRpcProtocolAdvertisement, NaidanRpcProtocolError } from '@/features/naidan-rpc';
import { PipingRetirementError, NaidanPipingDuplexSession, NaidanPipingPeerEndpoint } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { validateRpcTransport } from '@/00-storage/service/naidan-rpc';
import { encodePeerKey, decodePeerKey } from '@/features/naidan-rpc-integration/runtime/identity';
import { normalizeRpcPairingCode } from '@/features/naidan-rpc-integration/runtime/pairing-code';

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
    repairTimeoutMs: 15000,
    handshakeResponseTimeoutMs: 75_000,
    liveness: { intervalMs: 15_000, responseTimeoutMs: 75_000 },
    candidateConfirmationTimeoutMs: 15000,
    pacing: { minimumMs: 20, idleResendIntervalMs: 15000, retryBaseMs: 250, retryMaximumMs: 5000 },
  };
  if (peerKey !== undefined) {
    const local = encodePeerKey({ bytes: identity.publicKey });
    if (local === peerKey) throw new Error('Cannot connect to this device itself');
    return openPersistentPipingRpc({
      signal,
      validate: ({ bytes }) => {
        try {
          validateRpcProtocolAdvertisement({ bytes });
        } catch (error) {
          if (error instanceof NaidanRpcProtocolError) authenticatedProtocolFailures.add(error);
          throw error;
        }
      },
      create: ({ signal }) => NaidanPipingPeerEndpoint.create({
        piping,
        identity,
        expectedPeer: decodePeerKey({ value: peerKey }),
        purpose: 'naidan-rpc/registered-peer/v2',
        publicHandshakeData: createRpcProtocolAdvertisement(),
        handshakeData: undefined,
        signal,
      }),
    });
  }
  if (code === undefined || !verifyPeer) throw new Error('Pairing requires a shared code and explicit verifier');
  const normalized = normalizeRpcPairingCode({ code });
  // Use a bounded hash-code shape in the Duplex namespace. The
  // digest domain is separate from pinned routes; its shape cannot bypass
  // pair() and the explicit full comparison required for an unknown peer.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['naidan-peer-rpc-pairing/v1', normalized]))));
  signal.throwIfAborted();
  const rendezvousCode = 'peer-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  const pairing = await acceptRpcConnection({ connection: await NaidanPipingDuplexSession.pair({ piping, code: rendezvousCode, identity, verifyPeer, signal, publicHandshakeData: createRpcProtocolAdvertisement() }), signal });
  let pinned: RpcLink | undefined;
  try {
    // Both peers entering this fresh pinned handshake proves their temporary
    // verified pairing already returned. Keep it alive until mutual admission.
    pinned = await openPipingRpc({ settings, identity, peerKey: encodePeerKey({ bytes: pairing.peerIdentity }), code: undefined, verifyPeer: undefined, signal });
    pairing.abort({ reason: 'Verified pairing handed to the pinned endpoint' });
    await pairing.closed;
    signal.throwIfAborted(); return pinned;
  } catch (error) {
    let cleanup: { error: unknown } | undefined;
    try {
      pairing.abort({ reason: 'Pinned pairing handoff stopped' });
    } catch (failure) {
      cleanup = { error: failure };
    }
    const retired = await Promise.allSettled([pairing.closed, pinned?.persistent?.owner.stop({ reason: 'Pinned pairing handoff rejected', notice: 'abort' })]);
    for (const result of retired) switch (result.status) {
    case 'rejected': cleanup ??= { error: result.reason }; break;
    case 'fulfilled': break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
    if (cleanup) throw new PipingRetirementError({ cause: cleanup.error, logicalError: error });
    throw error;
  }
}
export const TEST_ONLY = {
};
