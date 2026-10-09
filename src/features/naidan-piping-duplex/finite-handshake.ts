import { ascii, equalBytes, fields, joinBytes, ownBytes, requireValue, u64 } from '@/features/naidan-piping-duplex/bytes';
import { AttemptError, sleep } from '@/features/naidan-piping-duplex/finite';
import { PipingStatusError } from '@/features/naidan-piping-duplex/finite-transfer';
import type { FiniteTransfer } from '@/features/naidan-piping-duplex/finite-transfer';
import { establishVerifiedNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingHandshakeChannel, NaidanPipingKeyContext, NaidanPipingPeerVerifier, PinnedContactStatus } from '@/features/naidan-piping-duplex/key-context';
import { HandshakeResponseUnconfirmedError } from '@/features/naidan-piping-duplex/lifetime';
import { normalizeRendezvousCode } from '@/features/naidan-piping-duplex/rendezvous';
import { encodeProtocolHeader, inspectProtocolHeader } from '@/features/naidan-piping-duplex/protocol-header';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import { isInitiator } from '@/features/naidan-piping-duplex/role';

const HANDSHAKE_BODY_BYTES = 65549;
const PUBLIC_BYTES = 256;
const PRIVATE_BYTES = 16384;
export type HandshakeResult = { keys: NaidanPipingKeyContext; peerPublicHandshakeData: Uint8Array; peerHandshakeData: Uint8Array };
type Material = { entry: string; secret: Uint8Array | CryptoKey; role?: NaidanPipingRole };
function base64url({ bytes }: { bytes: Uint8Array }): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function digest({ bytes }: { bytes: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
export function readOffer({ bytes }: { bytes: Uint8Array }): { attempt: Uint8Array; first: Uint8Array } {
  requireValue({ condition: bytes.length === 78 && bytes[13] === 0x21 && inspectProtocolHeader({ bytes, maxBytes: 78 }).kind === 'supported', message: 'Invalid connection OFFER' });
  const attempt = bytes.slice(14, 46); requireValue({ condition: attempt.some(Boolean), message: 'Empty attempt' });
  return { attempt, first: bytes.slice(46) };
}
function advertisement({ publicData, privateData }: { publicData: Uint8Array; privateData: Uint8Array }): Uint8Array {
  const outer = ownBytes({ bytes: publicData, maxBytes: PUBLIC_BYTES }), inner = ownBytes({ bytes: privateData, maxBytes: PRIVATE_BYTES });
  const length = new Uint8Array(2); new DataView(length.buffer).setUint16(0, outer.length);
  return joinBytes({ parts: [length, outer, inner] });
}
function readAdvertisement({ bytes }: { bytes: Uint8Array }): { peerPublicHandshakeData: Uint8Array; peerHandshakeData: Uint8Array } {
  requireValue({ condition: bytes.length >= 2 && bytes.length <= 2 + PUBLIC_BYTES + PRIVATE_BYTES, message: 'Invalid handshake advertisement' });
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
  requireValue({ condition: size <= PUBLIC_BYTES && size <= bytes.length - 2 && bytes.length - 2 - size <= PRIVATE_BYTES, message: 'Invalid handshake advertisement length' });
  return { peerPublicHandshakeData: bytes.slice(2, size + 2), peerHandshakeData: bytes.slice(size + 2) };
}

/** The first Noise flight is created once by key-context and carried by OFFER.
 * Later flights use one-use paths; no cumulative journal is constructed. */
export async function runHandshakeAttempt({ material, role, endpoint, identity, expectedPeer, verifyPeer, signal, responseTimeoutMs, data, owner, incoming, contact }: {
  material: Material; role: NaidanPipingRole; endpoint: FiniteTransfer; identity: NaidanPipingIdentity;
  expectedPeer: Uint8Array | undefined; verifyPeer: NaidanPipingPeerVerifier | undefined; signal: AbortSignal;
  responseTimeoutMs: number; data: Uint8Array; owner?: Uint8Array; incoming?: { attempt: Uint8Array; first: Uint8Array }; contact?: PinnedContactStatus;
}): Promise<HandshakeResult> {
  let first: Uint8Array | undefined, selected: Uint8Array;
  if (isInitiator({ role })) {
    selected = crypto.getRandomValues(new Uint8Array(32)); if (owner) selected.set(owner, 0);
  } else {
    const received = incoming ?? readOffer({ bytes: await endpoint.receive({ route: material.entry, maximum: 78, signal }) });
    selected = received.attempt; first = received.first;
    if (owner && equalBytes({ left: selected.subarray(0, 16), right: owner })) throw new AttemptError({ kind: 'transient' });
  }
  signal.throwIfAborted();
  const routeKey = material.secret instanceof Uint8Array ? await crypto.subtle.importKey('raw', new Uint8Array(material.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) : material.secret;
  const binding = await digest({ bytes: fields({ parts: [ascii({ text: 'naidan-piping-duplex/v1/handshake' }), ascii({ text: endpoint.origin }), ascii({ text: material.entry }), selected] }) });
  signal.throwIfAborted();
  const path = async ({ direction, number }: { direction: number; number: number }): Promise<string> => {
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', routeKey, fields({ parts: [ascii({ text: 'naidan-piping-duplex/v1/flight' }), selected, new Uint8Array([direction]), u64({ value: BigInt(number) })] })));
    signal.throwIfAborted(); return base64url({ bytes });
  };
  let sent = 0, received = 0;
  const tx = isInitiator({ role }) ? 1 : 2, rx = tx === 1 ? 2 : 1;
  const channel: NaidanPipingHandshakeChannel = {
    send: async ({ bytes, signal: current = signal, human = false }) => {
      const number = sent++;
      const posting = isInitiator({ role }) && number === 0;
      const route = posting ? material.entry : await path({ direction: tx, number });
      if (posting) requireValue({ condition: bytes.length === 32, message: 'Unexpected first Noise flight' });
      const payload = posting ? joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([0x21]), selected, bytes] })
        : joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([0x22]), bytes] });
      await endpoint.send({ route, bytes: payload, signal: current, timeoutMs: human ? null : undefined });
    },
    receive: async ({ signal: current, human = false }) => {
      const number = received++;
      if (!isInitiator({ role }) && number === 0) {
        const bytes = first!; first = undefined; current.throwIfAborted(); return bytes;
      }
      const route = await path({ direction: rx, number });
      const bytes = await endpoint.receive({ route, maximum: HANDSHAKE_BODY_BYTES, signal: current, timeoutMs: human ? null : undefined });
      requireValue({ condition: bytes.length > 14 && bytes[13] === 0x22 && inspectProtocolHeader({ bytes, maxBytes: HANDSHAKE_BODY_BYTES }).kind === 'supported', message: 'Invalid handshake flight' });
      return bytes.slice(14);
    },
  };
  const result = await establishVerifiedNaidanPipingKeys({
    role,
    identity,
    expectedPeer,
    verifyPeer,
    binding,
    channel,
    signal,
    responseTimeoutMs,
    onResponseFailure: undefined,
    handshakeData: data,
    contact,
  });
  try {
    signal.throwIfAborted(); return { keys: result.keys, ...(contact ? { peerPublicHandshakeData: new Uint8Array(), peerHandshakeData: result.peerHandshakeData.slice() } : readAdvertisement({ bytes: result.peerHandshakeData })) };
  } catch (error) {
    result.keys.dispose(); throw error;
  } finally {
    result.peerHandshakeData.fill(0); selected.fill(0);
  }
}

/** Only initial code pairing elects roles. A 400 never authenticates the other participant. */
export async function pairKeys({ endpoint, identity, code, role, verifyPeer, signal, responseTimeoutMs, publicHandshakeData, handshakeData }: {
  endpoint: FiniteTransfer; identity: NaidanPipingIdentity; code: string; role?: NaidanPipingRole; verifyPeer: NaidanPipingPeerVerifier;
  signal: AbortSignal; responseTimeoutMs: number; publicHandshakeData: Uint8Array; handshakeData: Uint8Array;
}): Promise<HandshakeResult> {
  const normalized = normalizeRendezvousCode({ code });
  const room = await digest({ bytes: fields({ parts: [ascii({ text: 'naidan-piping-duplex/v1/pair' }), ascii({ text: endpoint.origin }), ascii({ text: normalized })] }) });
  const material = { entry: base64url({ bytes: await digest({ bytes: fields({ parts: [room, ascii({ text: 'offer' })] }) }) }), secret: room };
  const owner = crypto.getRandomValues(new Uint8Array(16)), data = advertisement({ publicData: publicHandshakeData, privateData: handshakeData });
  let selectedRole = role ?? 'initiator', compared = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        return await runHandshakeAttempt({
          material,
          role: selectedRole,
          endpoint,
          identity,
          expectedPeer: undefined,
          verifyPeer: ({ peerIdentity, comparison, signal }) => {
            compared = true; return verifyPeer({ peerIdentity, comparison, signal });
          },
          signal,
          responseTimeoutMs,
          data,
          owner,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (compared) throw error;
        if (role === undefined && error instanceof PipingStatusError && error.status === 400) selectedRole = isInitiator({ role: selectedRole }) ? 'responder' : 'initiator';
        else if (error instanceof AttemptError && error.kind !== 'fatal' || error instanceof HandshakeResponseUnconfirmedError) selectedRole = role ?? 'initiator';
        else throw error;
        await sleep({ milliseconds: 150 + crypto.getRandomValues(new Uint8Array(1))[0]!, signal });
      }
    }
  } finally {
    owner.fill(0); room.fill(0); data.fill(0);
  }
}

export const TEST_ONLY = {
};
