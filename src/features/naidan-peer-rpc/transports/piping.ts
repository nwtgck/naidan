import { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { validateRpcTransport } from '@/00-storage/service/naidan-rpc';
import { encodePeerKey, decodePeerKey } from '@/features/naidan-peer-rpc/runtime/identity';
import { normalizeRpcPairingCode } from '@/features/naidan-peer-rpc/runtime/pairing-code';

export async function openPipingRpc({ settings, identity, peerKey, code, verifyPeer, signal }: {
  settings: NaidanRpcTransportSettings,
  identity: NaidanPipingIdentity,
  peerKey: string | undefined,
  code: string | undefined,
  verifyPeer: NaidanPipingPeerVerifier | undefined,
  signal: AbortSignal,
}): Promise<NaidanPipingDuplexSession> {
  const transport = validateRpcTransport({ value: settings });
  const piping = {
    baseUrl: transport.serverUrl,
    policy: transport.serverUrl.startsWith('https:') ? 'https-only' as const : 'allow-loopback-http' as const,
    headers: transport.headers.map(({ name, value }) => ({ name, value })),
    requestTimeoutMs: 120000,
    repairTimeoutMs: 15000,
    candidateConfirmationTimeoutMs: 15000,
    handshakeRetentionMs: undefined,
    pacing: { minimumMs: 20, idleResendIntervalMs: 15000, retryBaseMs: 250, retryMaximumMs: 5000 },
  };
  if (peerKey !== undefined) {
    const local = encodePeerKey({ bytes: identity.publicKey });
    if (local === peerKey) throw new Error('Cannot connect to this device itself');
    const ordered = [local, peerKey].sort();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['naidan-peer-rpc/v1', transport.serverUrl, ...ordered]))));
    signal.throwIfAborted();
    return NaidanPipingDuplexSession.connect({
      piping,
      identity,
      expectedPeer: decodePeerKey({ value: peerKey }),
      code: 'peer-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
      role: local === ordered[0] ? 'initiator' : 'responder',
      signal,
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
  return NaidanPipingDuplexSession.pair({ piping, code: rendezvousCode, identity, verifyPeer, signal });
}
export const TEST_ONLY = {
};
