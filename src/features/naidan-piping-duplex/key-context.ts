import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { ascii, ownBytes, fields, equalBytes, u64, joinBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { NoiseXX, createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type NaidanPipingDirection = 1 | 2;
const authenticated = Symbol('authenticated peer context');
export interface NaidanPipingHandshakeChannel {
    send({ bytes }: {
        bytes: Uint8Array;
    }): Promise<void>;
    receive({ signal }: {
        signal: AbortSignal;
    }): Promise<Uint8Array>;
}
async function digest({ bytes }: {
    bytes: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
async function rootKey({ bytes }: {
    bytes: Uint8Array;
}): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(bytes), 'HKDF', false, ['deriveBits', 'deriveKey']);
}
export class NaidanPipingKeyDomain {
  private readonly recordOwners = new Set<string>();
  private internalRoot: CryptoKey;
  private internalContext: Uint8Array<ArrayBuffer>;
  private internalDomain: Uint8Array;
  private internalLive: () => void;
  constructor({ root, context, domain, live }: {
        root: CryptoKey;
        context: Uint8Array;
        domain: Uint8Array;
        live: () => void;
    }) {
    this.internalRoot = root;
    this.internalContext = new Uint8Array(context);
    this.internalDomain = domain;
    this.internalLive = live;
  }
  /** Ownership is never released: reconstructing a codec must not reset its nonce or replay watermark. */
  claimRecordOwner({ direction, usage, context }: {
        direction: NaidanPipingDirection; usage: 'encrypt' | 'decrypt'; context: Uint8Array;
    }): void {
    this.internalLive();
    requireValue({ condition: (direction === 1 || direction === 2) &&
            (usage === 'encrypt' || usage === 'decrypt') && equalBytes({ left: context, right: this.internalContext }),
    message: 'Invalid record ownership scope' });
    const scope = `${direction}/${usage}`;
    requireValue({ condition: !this.recordOwners.has(scope), message: 'Record ownership already consumed' });
    this.recordOwners.add(scope);
  }
  assertActive(): void {
    this.internalLive();
  }
  async aead({ direction, epoch, usage }: {
        direction: NaidanPipingDirection;
        epoch: bigint;
        usage: 'encrypt' | 'decrypt';
    }): Promise<CryptoKey> {
    this.internalLive();
    requireValue({ condition: (direction === 1 || direction === 2) && epoch >= 0n && epoch < (1n << 48n), message: 'Key scope' });
    // Local permission is NOT a KDF input: reciprocal peers must derive the same key bytes.
    const info = fields({ parts: [this.internalDomain, ascii({ text: 'record-aead/v1' }), new Uint8Array([direction]), u64({ value: epoch })] });
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: this.internalContext, info }, this.internalRoot, { name: 'AES-GCM', length: 256 }, false, [usage]);
    this.internalLive();
    return key;
  }
  async route({ direction }: {
        direction: NaidanPipingDirection;
    }): Promise<string> {
    this.internalLive();
    requireValue({ condition: direction === 1 || direction === 2, message: 'Direction' });
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: this.internalContext,
      info: fields({ parts: [this.internalDomain, ascii({ text: 'route-key/v1' })] }) }, this.internalRoot, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, fields({ parts: [ascii({ text: 'mailbox/v1' }), this.internalContext, new Uint8Array([direction])] })));
    this.internalLive();
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
}
export class NaidanPipingKeyContext {
  readonly role: NaidanPipingRole;
  private internalRoot: CryptoKey | undefined;
  private internalId: Uint8Array;
  private internalPeer: Uint8Array;
  private internalDomains = new Set<string>();
  constructor({ role, root, id, peer, proof }: {
        role: NaidanPipingRole;
        root: CryptoKey;
        id: Uint8Array;
        peer: Uint8Array;
        proof: typeof authenticated;
    }) {
    requireValue({ condition: proof === authenticated, message: 'Use authenticated establishment' });
    this.role = role;
    this.internalRoot = root;
    this.internalId = id.slice();
    this.internalPeer = peer.slice();
  }
  get contextId(): Uint8Array {
    return this.internalId.slice();
  }
  get peerIdentity(): Uint8Array {
    return this.internalPeer.slice();
  }
  private internalCheckLive(): void {
    if (!this.internalRoot)
      throw new Error('Key context disposed');
  }
  createDomain({ label, context }: {
        label: string;
        context: Uint8Array;
    }): NaidanPipingKeyDomain {
    this.internalCheckLive();
    requireValue({ condition: /^[a-z0-9][a-z0-9./_-]{0,63}$/.test(label), message: 'Domain label' });
    const copy = ownBytes({ bytes: context, maxBytes: 4096 });
    const domain = fields({ parts: [ascii({ text: label }), copy] });
    const id = Array.from(domain, byte => byte.toString(16).padStart(2, '0')).join('');
    requireValue({ condition: !this.internalDomains.has(id) && this.internalDomains.size < 64, message: 'Domain consumed/capacity' });
    this.internalDomains.add(id);
    if (!this.internalRoot)
      throw new Error('Key context disposed');
    return new NaidanPipingKeyDomain({ root: this.internalRoot, context: this.internalId.slice(), domain, live: () => this.internalCheckLive() });
  }
  dispose(): void {
    this.internalRoot = undefined;
  }
}
export async function establishVerifiedNaidanPipingKeys({ role, identity, expectedPeer, verifyPeer, binding, channel, signal }: {
    role: NaidanPipingRole;
    identity: NaidanPipingIdentity;
    expectedPeer: Uint8Array | undefined;
    verifyPeer: NaidanPipingPeerVerifier | undefined;
    binding: Uint8Array;
    channel: NaidanPipingHandshakeChannel;
    signal: AbortSignal;
}): Promise<NaidanPipingKeyContext> {
  requireValue({ condition: isInitiator({ role: role }) || !isInitiator({ role: role }), message: 'Invalid role' });
  const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 }), sharedBinding = ownBytes({ bytes: binding, maxBytes: 32 });
  const local: NaidanPipingIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  requireValue({ condition: (pin?.length === 32 || (pin === undefined && verifyPeer !== undefined)) && sharedBinding.length === 32, message: 'A trusted pin or explicit comparison and binding are mandatory' });
  signal.throwIfAborted();
  const state = await NoiseXX.create({ role, identity: local, ephemeral: await createNaidanPipingIdentity(),
    prologue: fields({ parts: [ascii({ text: 'peer-key-profile/v1' }), sharedBinding, ascii({ text: 'initiator/responder' })] }) });
  const sensitive: Uint8Array[] = [];
  let noise: Awaited<ReturnType<NoiseXX['split']>> | undefined;
  try {
    for (let flight = 0; flight < 3; flight++) {
      signal.throwIfAborted();
      const outgoing = (flight !== 1) === (isInitiator({ role: role }));
      if (outgoing) {
        const bytes = await state.exchange({ operation: 'write', bytes: new Uint8Array() });
        signal.throwIfAborted();
        await channel.send({ bytes });
      } else {
        const payload = await state.exchange({ operation: 'read', bytes: await channel.receive({ signal }) });
        requireValue({ condition: payload.length === 0, message: 'Unexpected handshake payload' });
        // Authenticate a received static identity before sending the next flight.
        const peer = state.peerIdentity;
        if (peer && pin)
          requireValue({ condition: equalBytes({ left: pin, right: peer }), message: 'Peer identity mismatch' });
      }
    }
    const established = await state.split();
    noise = established;
    signal.throwIfAborted();
    if (pin) requireValue({ condition: equalBytes({ left: pin, right: established.peerIdentity }), message: 'Peer identity mismatch' });
    const staticI = isInitiator({ role: role }) ? local.publicKey : established.peerIdentity;
    const staticR = !isInitiator({ role: role }) ? local.publicKey : established.peerIdentity;
    const sessionBinding = await digest({ bytes: fields({ parts: [ascii({ text: 'peer-key-binding/v1' }), established.binding, staticI, staticR] }) });
    const send = async ({ bytes }: {
            bytes: Uint8Array;
        }) => {
      signal.throwIfAborted();
      const ciphertext = await established.send.crypt({ operation: 'encrypt', bytes, aad: new Uint8Array() });
      signal.throwIfAborted();
      await channel.send({ bytes: ciphertext });
    };
    const receive = async () => {
      const encrypted = await channel.receive({ signal });
      const bytes = await established.receive.crypt({ operation: 'decrypt', bytes: encrypted, aad: new Uint8Array() });
      signal.throwIfAborted();
      return bytes;
    };
    const trustFlag = pin ? 1 : 0;
    await send({ bytes: joinBytes({ parts: [new Uint8Array([1, trustFlag]), sessionBinding] }) });
    const status = await receive();
    requireValue({ condition: status.length === 34 && status[0] === 1 && (status[1] === 0 || status[1] === 1) &&
      equalBytes({ left: status.subarray(2), right: sessionBinding }), message: 'Authentication status mismatch' });
    if (trustFlag === 0 || status[1] === 0) {
      if (!verifyPeer) throw new Error('This connection needs an explicit peer comparison');
      // The full 256-bit channel binding is compared over an already authenticated external path.
      // Never truncate this to the short, public rendezvous number or reuse it across attempts.
      const verified = await verifyComparison({ verifyPeer, peerIdentity: established.peerIdentity, comparison: sessionBinding, signal });
      signal.throwIfAborted();
      requireValue({ condition: verified === true, message: 'Peer comparison rejected' });
      await send({ bytes: joinBytes({ parts: [new Uint8Array([2]), sessionBinding] }) });
      const approval = await receive();
      requireValue({ condition: equalBytes({ left: approval, right: joinBytes({ parts: [new Uint8Array([2]), sessionBinding] }) }),
        message: 'Peer did not approve this connection' });
    }
    const seed = crypto.getRandomValues(new Uint8Array(32));
    sensitive.push(seed);
    await send({ bytes: joinBytes({ parts: [new Uint8Array([6]), seed] }) });
    const peerSeed = await receive();
    sensitive.push(peerSeed);
    requireValue({ condition: peerSeed.length === 33 && peerSeed[0] === 6, message: 'Export seed' });
    const material = joinBytes({ parts: isInitiator({ role: role }) ? [seed, peerSeed.subarray(1)] : [peerSeed.subarray(1), seed] });
    sensitive.push(material);
    const imported = await rootKey({ bytes: material });
    const rootBytes = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sessionBinding,
      info: fields({ parts: [ascii({ text: 'peer-key-export/v1' })] }) }, imported, 256));
    sensitive.push(rootBytes);
    const contextId = await digest({ bytes: fields({ parts: [ascii({ text: 'peer-key-context/v1' }), sessionBinding, await digest({ bytes: material })] }) });
    seed.fill(0);
    peerSeed.fill(0);
    material.fill(0);
    const root = await rootKey({ bytes: rootBytes });
    rootBytes.fill(0);
    const confirmation = async ({ direction }: {
            direction: NaidanPipingDirection;
        }) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
      salt: sessionBinding, info: fields({ parts: [ascii({ text: 'peer-key-confirm/v1' }), new Uint8Array([direction])] }) }, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const sendKey = await confirmation({ direction: isInitiator({ role: role }) ? 1 : 2 });
    const receiveKey = await confirmation({ direction: isInitiator({ role: role }) ? 2 : 1 });
    const confirmInput = fields({ parts: [sessionBinding, contextId] });
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', sendKey, confirmInput));
    await send({ bytes: joinBytes({ parts: [new Uint8Array([7]), mac] }) });
    const peerMac = await receive();
    requireValue({ condition: peerMac.length === 33 && peerMac[0] === 7, message: 'Key confirmation encoding' });
    requireValue({ condition: await crypto.subtle.verify('HMAC', receiveKey, peerMac.subarray(1), confirmInput), message: 'Key confirmation failed' });
    signal.throwIfAborted();
    return new NaidanPipingKeyContext({ role, root, id: contextId, peer: established.peerIdentity, proof: authenticated });
  } finally {
    for (const bytes of sensitive)
      bytes.fill(0);
    state.dispose();
    noise?.send.dispose();
    noise?.receive.dispose();
  }
}

export type NaidanPipingPeerVerifier = ({ peerIdentity, comparison, signal }: {
  peerIdentity: Uint8Array; comparison: Uint8Array; signal: AbortSignal;
}) => Promise<boolean>;

async function verifyComparison({ verifyPeer, peerIdentity, comparison, signal }: {
  verifyPeer: NaidanPipingPeerVerifier; peerIdentity: Uint8Array; comparison: Uint8Array; signal: AbortSignal;
}): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Own late rejection even when the user never completes the obsolete confirmation dialog.
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return verifyPeer({ peerIdentity: peerIdentity.slice(), comparison: comparison.slice(), signal });
    })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function establishNaidanPipingKeys({ role, identity, expectedPeer, binding, channel, signal }: {
  role: NaidanPipingRole; identity: NaidanPipingIdentity; expectedPeer: Uint8Array;
  binding: Uint8Array; channel: NaidanPipingHandshakeChannel; signal: AbortSignal;
}): Promise<NaidanPipingKeyContext> {
  // Keep the existing pinned-only entrypoint incapable of silently trusting a new key.
  return establishVerifiedNaidanPipingKeys({ role, identity, expectedPeer, verifyPeer: undefined, binding, channel, signal });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  verifyComparison,
};
