import { ascii, fields, ownBytes, requireValue } from './bytes';
import type { NaidanPipingIdentity } from './noise-xx';
import { PROTOCOL_VERSION } from './protocol-header';
import type { NaidanPipingRole } from './role';

/** Routing material only. Fresh Noise still authenticates each session and owns its record keys. */
export async function pinnedPeerRoutes({ identity, expectedPeer, origin, purpose, signal }: {
  identity: NaidanPipingIdentity; expectedPeer: Uint8Array; origin: string; purpose: string; signal: AbortSignal;
}): Promise<{ send: string; receive: string; role: NaidanPipingRole }> {
  const privateKey = identity.privateKey;
  const local = ownBytes({ bytes: identity.publicKey, maxBytes: 32 }), peer = ownBytes({ bytes: expectedPeer, maxBytes: 32 });
  requireValue({ condition: local.length === 32 && peer.length === 32, message: 'Pinned identity size' });
  let ordering = 0;
  for (let index = 0; index < 32 && ordering === 0; index++) ordering = local[index]! - peer[index]!;
  requireValue({ condition: ordering !== 0, message: 'Distinct pinned identities required' });
  const url = new URL(origin);
  requireValue({ condition: (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', message: 'Explicit relay origin required' });
  const purposeBytes = ascii({ text: purpose });
  requireValue({ condition: purposeBytes.length > 0 && purposeBytes.length <= 256, message: 'Pinned peer purpose' });
  signal.throwIfAborted();
  // Identity restoration normally validates this already; the public Duplex
  // entry point also rejects a mismatched label/private-key pair on its own.
  const challenge = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const localKey = await crypto.subtle.importKey('raw', local, 'X25519', false, []);
  const checks: Uint8Array[] = [];
  try {
    checks.push(new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: challenge.publicKey }, privateKey, 256)));
    signal.throwIfAborted();
    checks.push(new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: localKey }, challenge.privateKey, 256)));
    let difference = 0;
    for (let index = 0; index < 32; index++) difference |= checks[0]![index]! ^ checks[1]![index]!;
    requireValue({ condition: checks[0]!.some(Boolean) && difference === 0, message: 'Local identity key pair mismatch' });
  } finally {
    for (const bytes of checks) bytes.fill(0);
  }
  const remoteKey = await crypto.subtle.importKey('raw', peer, 'X25519', false, []);
  signal.throwIfAborted();
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: remoteKey }, privateKey, 256));
  try {
    signal.throwIfAborted();
    requireValue({ condition: shared.some(Boolean), message: 'Invalid X25519 routing result' });
    const key = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const version = new Uint8Array(4); new DataView(version.buffer).setUint32(0, PROTOCOL_VERSION, true);
    const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({
      parts: [
        ascii({ text: 'naidan-piping-pinned-route-context/v1' }), version, ascii({ text: url.origin }), purposeBytes,
        ...(ordering < 0 ? [local, peer] : [peer, local]),
      ],
    })));
    const derive = async ({ direction }: { direction: string }) => {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await crypto.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: fields({ parts: [ascii({ text: 'naidan-piping-pinned-route-only/v1' }), ascii({ text: direction })] }),
      }, key, 256));
      signal.throwIfAborted();
      return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    };
    const low = await derive({ direction: 'low-to-high' }), high = await derive({ direction: 'high-to-low' });
    return ordering < 0 ? { send: low, receive: high, role: 'initiator' } : { send: high, receive: low, role: 'responder' };
  } finally {
    shared.fill(0);
  }
}

export const TEST_ONLY = {
};
