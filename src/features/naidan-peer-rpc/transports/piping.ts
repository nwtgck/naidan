import { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier, NaidanPipingRole } from '@/features/naidan-piping-duplex';
import type { NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { validateRpcTransport } from '@/00-storage/service/naidan-rpc';
import { encodePeerKey, decodePeerKey } from '@/features/naidan-peer-rpc/runtime/identity';

export async function openPipingRpc({ settings, identity, peerKey, code, role, verifyPeer, signal }: {
  settings: NaidanRpcTransportSettings,
  identity: NaidanPipingIdentity,
  peerKey: string | undefined,
  code: string | undefined,
  role: NaidanPipingRole | undefined,
  verifyPeer: NaidanPipingPeerVerifier | undefined,
  signal: AbortSignal,
}): Promise<NaidanPipingDuplexSession> {
  const transport = validateRpcTransport({ value: settings });
  const piping = {
    baseUrl: transport.serverUrl,
    policy: transport.serverUrl.startsWith('https:') ? 'https-only' as const : 'allow-loopback-http' as const,
    headers: transport.headers.map(({ name, value }) => ({ name, value })),
    requestTimeoutMs: 120000, repairTimeoutMs: 15000,
    connectionTimeoutMs: undefined, handshakeRetentionMs: undefined,
    pacing: { minimumMs: 20, heartbeatMs: 15000, retryBaseMs: 250, retryMaximumMs: 5000 },
  };
  if (peerKey !== undefined) {
    const local = encodePeerKey({ bytes: identity.publicKey });
    if (local === peerKey) throw new Error('Cannot connect to this device itself');
    const ordered = [local, peerKey].sort();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['naidan-peer-rpc/v1', transport.serverUrl, ...ordered]))));
    signal.throwIfAborted();
    return NaidanPipingDuplexSession.connect({ piping, identity, expectedPeer: decodePeerKey({ value: peerKey }),
      code: 'peer-' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''), role: local === ordered[0] ? 'initiator' : 'responder', signal });
  }
  if (!code || !/^[0-9]{4,8}$/.test(code) || !role || !verifyPeer) throw new Error('Enter the same 4–8 digit number on both devices');
  return NaidanPipingDuplexSession.pair({ piping, code, identity, role, verifyPeer, signal });
}
export const TEST_ONLY = {
};
