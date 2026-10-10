import { promiseAllKeyed } from '@/utils/promise';
import type { HandshakeResponseStage } from '@/features/naidan-piping-duplex/lifetime';
import { PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
import { HandshakeResponses, systemResponseClock } from '@/features/naidan-piping-duplex/response-window';
import type { ResponseWindow } from '@/features/naidan-piping-duplex/response-window';
import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { ascii, ownBytes, fields, equalBytes, u64, joinBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { NoiseXX, createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type NaidanPipingDirection = 1 | 2;
const authenticated = Symbol('authenticated peer context');
export interface NaidanPipingHandshakeChannel {
    send({ bytes }: {
        signal?: AbortSignal;
        human?: boolean;
        bytes: Uint8Array;
    }): Promise<void>;
    receive({ signal }: {
        human?: boolean;
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
    requireValue({
      condition: (direction === 1 || direction === 2) &&
            (usage === 'encrypt' || usage === 'decrypt') && equalBytes({ left: context, right: this.internalContext }),
      message: 'Invalid record ownership scope',
    });
    const scope = `${direction}/${usage}`;
    requireValue({ condition: !this.recordOwners.has(scope), message: 'Record ownership already consumed' });
    this.recordOwners.add(scope);
  }

  private batchRouteKey: Promise<CryptoKey> | undefined;

  async batchRoute({ direction, number }: { direction: NaidanPipingDirection; number: bigint }): Promise<string> {
    this.internalLive();
    requireValue({ condition: (direction === 1 || direction === 2) && number >= 0n && number < (1n << 48n), message: 'Data route scope' });
    this.batchRouteKey ??= crypto.subtle.deriveKey({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: this.internalContext,
      info: fields({ parts: [this.internalDomain, ascii({ text: 'finite-data-route/v1' })] }),
    }, this.internalRoot, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const key = await this.batchRouteKey;
    this.internalLive();
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, fields({
      parts: [ascii({ text: 'finite-data-path/v1' }), this.internalContext, new Uint8Array([direction]), u64({ value: number })],
    })));
    this.internalLive();
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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
    const key = await crypto.subtle.deriveKey({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: this.internalContext,
      info: fields({ parts: [this.internalDomain, ascii({ text: 'route-key/v1' })] }),
    }, this.internalRoot, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
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
/** Pinned-only, authenticated admission barrier. It does not expose split ciphers. */
export type PinnedContactStatus = {
  heldContext: Uint8Array | undefined;
  publicHandshakeData: Uint8Array;
  confirm({ peerHeldContext, peerPublicHandshakeData, signal }: {
    peerHeldContext: Uint8Array | undefined; peerPublicHandshakeData: Uint8Array; signal: AbortSignal;
  }): Promise<void>;
};

function contactStatus({ binding, heldContext, publicData }: { binding: Uint8Array; heldContext: Uint8Array | undefined; publicData: Uint8Array }): Uint8Array {
  const size = new Uint8Array(2); new DataView(size.buffer).setUint16(0, publicData.length);
  return joinBytes({ parts: [new Uint8Array([8, 1]), binding, new Uint8Array([heldContext ? 1 : 0]), ...(heldContext ? [heldContext] : []), size, publicData] });
}

function readContactStatus({ bytes, binding }: { bytes: Uint8Array; binding: Uint8Array }): { peerHeldContext: Uint8Array | undefined; peerPublicHandshakeData: Uint8Array } {
  requireValue({ condition: bytes.length >= 37 && bytes.length <= 325 && bytes[0] === 8 && bytes[1] === 1 && equalBytes({ left: bytes.subarray(2, 34), right: binding }) && (bytes[34] === 0 || bytes[34] === 1), message: 'Invalid pinned contact status' });
  const offset = bytes[34] === 1 ? 67 : 35;
  requireValue({ condition: bytes.length >= offset + 2, message: 'Truncated pinned contact status' });
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
  requireValue({ condition: size <= 256 && bytes.length === offset + 2 + size, message: 'Invalid pinned contact advertisement' });
  return { peerHeldContext: bytes[34] === 1 ? bytes.slice(35, 67) : undefined, peerPublicHandshakeData: bytes.slice(offset + 2) };
}

export type EstablishedPipingKeys = { keys: NaidanPipingKeyContext; peerHandshakeData: Uint8Array };

export async function establishVerifiedNaidanPipingKeys({ role, identity, expectedPeer, verifyPeer, binding, channel, signal: parent, responseTimeoutMs, onResponseFailure, handshakeData = new Uint8Array(), contact }: {
    role: NaidanPipingRole;
    identity: NaidanPipingIdentity;
    expectedPeer: Uint8Array | undefined;
    verifyPeer: NaidanPipingPeerVerifier | undefined;
    binding: Uint8Array;
    channel: NaidanPipingHandshakeChannel;
    signal: AbortSignal;
    responseTimeoutMs: number;
    onResponseFailure: (({ error }: { error: unknown }) => void) | undefined;
    handshakeData?: Uint8Array;
    contact?: PinnedContactStatus;
}): Promise<EstablishedPipingKeys> {
  const localData = ownBytes({ bytes: handshakeData, maxBytes: 16642 });
  let peerData = new Uint8Array();
  const heldContext = contact?.heldContext === undefined ? undefined : ownBytes({ bytes: contact.heldContext, maxBytes: 32 });
  const publicData = ownBytes({ bytes: contact?.publicHandshakeData ?? new Uint8Array(), maxBytes: 256 });
  requireValue({ condition: heldContext === undefined || heldContext.length === 32, message: 'Contact context size' });
  requireValue({ condition: !contact || expectedPeer !== undefined, message: 'Contact requires a trusted pin' });
  let statusBinding = new Uint8Array();
  requireValue({ condition: isInitiator({ role: role }) || !isInitiator({ role: role }), message: 'Invalid role' });
  const pin = expectedPeer === undefined ? undefined : ownBytes({ bytes: expectedPeer, maxBytes: 32 }), sharedBinding = ownBytes({ bytes: binding, maxBytes: 32 });
  const local: NaidanPipingIdentity = { privateKey: identity.privateKey, publicKey: ownBytes({ bytes: identity.publicKey, maxBytes: 32 }) };
  requireValue({ condition: (pin?.length === 32 || (pin === undefined && verifyPeer !== undefined)) && sharedBinding.length === 32, message: 'A trusted pin or explicit comparison and binding are mandatory' });
  const responses = new HandshakeResponses({ parent, milliseconds: responseTimeoutMs, clock: systemResponseClock, onFailure: onResponseFailure });
  const signal = responses.signal;
  const sensitive: Uint8Array[] = [];
  let state: NoiseXX | undefined;
  let noise: Awaited<ReturnType<NoiseXX['split']>> | undefined;
  let result: NaidanPipingKeyContext | undefined;
  let failure: { error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];
  try {
    signal.throwIfAborted();
    // Key generation and other standalone local preparation have no response window.
    state = await NoiseXX.create({
      role,
      identity: local,
      ephemeral: await createNaidanPipingIdentity(),
      prologue: fields({ parts: [ascii({ text: 'peer-key-profile/v1' }), sharedBinding, ascii({ text: 'initiator/responder' })] }),
    });
    let noiseWindow: ResponseWindow | undefined;
    for (let flight = 0; flight < 3; flight++) {
      signal.throwIfAborted();
      const outgoing = (flight !== 1) === (isInitiator({ role: role }));
      if (outgoing) {
        const bytes = await state.exchange({ operation: 'write', bytes: new Uint8Array() });
        signal.throwIfAborted();
        // Prepared bytes exist before the registration-relative clock begins.
        if (flight < 2) noiseWindow = responses.arm({ stage: flight === 0 ? 'noise-2' : 'noise-3' });
        await channel.send({ bytes, signal });
        if (noiseWindow !== undefined) requireValue({ condition: responses.check({ window: noiseWindow }), message: 'Stale Noise registration' });
      } else {
        const payload = await state.exchange({ operation: 'read', bytes: await channel.receive({ signal }) });
        requireValue({ condition: payload.length === 0, message: 'Unexpected handshake payload' });
        // Authenticate a received static identity before sending the next flight.
        const peer = state.peerIdentity;
        if (peer && pin)
          requireValue({ condition: equalBytes({ left: pin, right: peer }), message: 'Peer identity mismatch' });
        if (noiseWindow !== undefined) {
          requireValue({ condition: responses.accept({ window: noiseWindow }), message: 'Stale Noise response' });
          noiseWindow = undefined;
        }
      }
    }
    const established = await state.split();
    noise = established;
    signal.throwIfAborted();
    if (pin) requireValue({ condition: equalBytes({ left: pin, right: established.peerIdentity }), message: 'Peer identity mismatch' });
    const staticI = isInitiator({ role: role }) ? local.publicKey : established.peerIdentity;
    const staticR = !isInitiator({ role: role }) ? local.publicKey : established.peerIdentity;
    const sessionBinding = await digest({ bytes: fields({ parts: [ascii({ text: 'peer-key-binding/v1' }), established.binding, staticI, staticR] }) });
    const encrypt = async ({ bytes }: { bytes: Uint8Array }) => {
      signal.throwIfAborted();
      const ciphertext = await established.send.crypt({ operation: 'encrypt', bytes, aad: new Uint8Array() });
      signal.throwIfAborted();
      return ciphertext;
    };
    const send = async ({ bytes, human = false }: { bytes: Uint8Array; human?: boolean }) => channel.send({ bytes: await encrypt({ bytes }), signal, human });
    const request = async ({ bytes, stage }: { bytes: Uint8Array; stage: HandshakeResponseStage }): Promise<ResponseWindow> => {
      const ciphertext = await encrypt({ bytes });
      const window = responses.arm({ stage });
      // Include registration and any uncooperative send wait, never prior crypto prep.
      await channel.send({ bytes: ciphertext, signal });
      requireValue({ condition: responses.check({ window }), message: 'Stale response registration' });
      return window;
    };
    const receive = async ({ human = false }: { human?: boolean } = {}) => {
      const encrypted = await channel.receive({ signal, human });
      const bytes = await established.receive.crypt({ operation: 'decrypt', bytes: encrypted, aad: new Uint8Array() });
      if (signal.aborted) bytes.fill(0);
      signal.throwIfAborted();
      return bytes;
    };
    // Finite POST completion requires a concurrent peer GET. Both operations
    // remain owned until settled, including when either native operation fails.
    const mutual = async <Sent>({ sending, receiving }: { sending: Promise<Sent>; receiving: Promise<Uint8Array<ArrayBuffer>> }) => {
      void sending.catch(error => responses.fail({ error })); void receiving.catch(error => responses.fail({ error }));
      const settled = await Promise.allSettled([sending, receiving]);
      // The first failed exchange cancels its sibling. A later cancellation
      // failure still owns resources and must not become a retryable error.
      for (const outcome of settled) {
        if (outcome.status === 'rejected' && outcome.reason instanceof PipingRetirementError) throw outcome.reason;
      }
      signal.throwIfAborted(); return promiseAllKeyed({ sent: sending, received: receiving });
    };
    if (contact) {
      const localStatus = contactStatus({ binding: sessionBinding, heldContext, publicData });
      sensitive.push(localStatus);
      // Only one control HTTP operation per endpoint while old DATA remains live.
      let peerStatus: Uint8Array;
      if (isInitiator({ role })) {
        const window = await request({ bytes: localStatus, stage: 'status' });
        peerStatus = await receive();
        readContactStatus({ bytes: peerStatus, binding: sessionBinding });
        requireValue({ condition: responses.accept({ window }), message: 'Stale contact response' });
      } else {
        peerStatus = await receive();
        readContactStatus({ bytes: peerStatus, binding: sessionBinding });
        const window = await request({ bytes: localStatus, stage: 'status' });
        requireValue({ condition: responses.accept({ window }), message: 'Stale contact response' });
      }
      sensitive.push(peerStatus);
      statusBinding = fields({ parts: isInitiator({ role }) ? [localStatus, peerStatus] : [peerStatus, localStatus] });
      await contact.confirm({ ...readContactStatus({ bytes: peerStatus, binding: sessionBinding }), signal });
      signal.throwIfAborted();
    } else {
      const trustFlag = pin ? 1 : 0;
      const { sent: statusWindow, received: status } = await mutual({
        sending: request({ bytes: joinBytes({ parts: [new Uint8Array([1, trustFlag]), sessionBinding] }), stage: 'status' }),
        receiving: receive(),
      });
      requireValue({
        condition: status.length === 34 && status[0] === 1 && (status[1] === 0 || status[1] === 1) &&
        equalBytes({ left: status.subarray(2), right: sessionBinding }),
        message: 'Authentication status mismatch',
      });
      requireValue({ condition: responses.accept({ window: statusWindow }), message: 'Stale trust status' });
      if (trustFlag === 0 || status[1] === 0) {
        if (!verifyPeer) throw new Error('This connection needs an explicit peer comparison');
        // The full 256-bit channel binding is compared over an already authenticated external path.
        // Never truncate this to the short, public rendezvous number or reuse it across attempts.
        const verified = await verifyComparison({ verifyPeer, peerIdentity: established.peerIdentity, comparison: sessionBinding, signal });
        signal.throwIfAborted();
        requireValue({ condition: verified === true, message: 'Peer comparison rejected' });
        const { received: approval } = await mutual({
          sending: send({ bytes: joinBytes({ parts: [new Uint8Array([2]), sessionBinding] }), human: true }),
          receiving: receive({ human: true }),
        });
        requireValue({
          condition: equalBytes({ left: approval, right: joinBytes({ parts: [new Uint8Array([2]), sessionBinding] }) }),
          message: 'Peer did not approve this connection',
        });
      }
    }
    const seed = crypto.getRandomValues(new Uint8Array(32));
    sensitive.push(seed);
    const { sent: seedWindow, received: peerSeed } = await mutual({
      sending: request({ bytes: joinBytes({ parts: [new Uint8Array([6]), seed, localData] }), stage: 'seed' }),
      receiving: receive(),
    });
    sensitive.push(peerSeed);
    requireValue({ condition: peerSeed.length >= 33 && peerSeed.length <= 16675 && peerSeed[0] === 6, message: 'Export seed' });
    requireValue({ condition: responses.accept({ window: seedWindow }), message: 'Stale export seed' });
    peerData = peerSeed.slice(33);
    const material = joinBytes({ parts: isInitiator({ role: role }) ? [seed, peerSeed.subarray(1, 33)] : [peerSeed.subarray(1, 33), seed] });
    sensitive.push(material);
    const imported = await rootKey({ bytes: material });
    const rootBytes = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sessionBinding,
      info: fields({ parts: [ascii({ text: 'peer-key-export/v1' })] }),
    }, imported, 256));
    sensitive.push(rootBytes);
    const contextId = await digest({ bytes: fields({ parts: [ascii({ text: 'peer-key-context/v1' }), sessionBinding, await digest({ bytes: material }), ...(isInitiator({ role }) ? [localData, peerData] : [peerData, localData]), ...(contact ? [statusBinding] : [])] }) });
    seed.fill(0);
    peerSeed.fill(0);
    material.fill(0);
    const root = await rootKey({ bytes: rootBytes });
    rootBytes.fill(0);
    const confirmation = async ({ direction }: {
            direction: NaidanPipingDirection;
        }) => crypto.subtle.deriveKey({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sessionBinding,
      info: fields({ parts: [ascii({ text: 'peer-key-confirm/v1' }), new Uint8Array([direction])] }),
    }, root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const sendKey = await confirmation({ direction: isInitiator({ role: role }) ? 1 : 2 });
    const receiveKey = await confirmation({ direction: isInitiator({ role: role }) ? 2 : 1 });
    const confirmInput = fields({ parts: [sessionBinding, contextId] });
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', sendKey, confirmInput));
    const { sent: confirmationWindow, received: peerMac } = await mutual({
      sending: request({ bytes: joinBytes({ parts: [new Uint8Array([7]), mac] }), stage: 'confirmation' }),
      receiving: receive(),
    });
    requireValue({ condition: peerMac.length === 33 && peerMac[0] === 7, message: 'Key confirmation encoding' });
    requireValue({ condition: await crypto.subtle.verify('HMAC', receiveKey, peerMac.subarray(1), confirmInput), message: 'Key confirmation failed' });
    requireValue({ condition: responses.accept({ window: confirmationWindow }), message: 'Stale key confirmation' });
    signal.throwIfAborted();
    result = new NaidanPipingKeyContext({ role, root, id: contextId, peer: established.peerIdentity, proof: authenticated });
  } catch (error) {
    // Keep the first logical cancellation, unless an owned operation failed to retire.
    failure = { error: error instanceof PipingRetirementError ? error : signal.aborted ? signal.reason : error };
    responses.fail({ error: failure.error });
  } finally {
    responses.dispose();
    localData.fill(0); publicData.fill(0); heldContext?.fill(0); statusBinding.fill(0);
    for (const bytes of sensitive)
      bytes.fill(0);
    for (const dispose of [() => state?.dispose(), () => noise?.send.dispose(), () => noise?.receive.dispose()]) {
      try {
        dispose();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (responses.retirementFailure) cleanupFailures.push(responses.retirementFailure.error);
  if (cleanupFailures.length) {
    try {
      result?.dispose();
    } catch (error) {
      cleanupFailures.push(error);
    }
    peerData.fill(0);
    throw new PipingRetirementError({ cause: cleanupFailures[0], logicalError: failure?.error });
  }
  if (failure) {
    peerData.fill(0); throw failure.error;
  }
  if (!result) throw new Error('Key establishment did not produce a result');
  return { keys: result, peerHandshakeData: peerData };
}

/** Caller-owned UI work: close the dialog when signal aborts. The library fences
 * late output and observes rejection; it cannot cancel an arbitrary verifier
 * promise or claim caller-owned UI resources have physically retired. */
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

export function establishNaidanPipingKeys({ role, identity, expectedPeer, binding, channel, signal, responseTimeoutMs }: {
  role: NaidanPipingRole; identity: NaidanPipingIdentity; expectedPeer: Uint8Array;
  binding: Uint8Array; channel: NaidanPipingHandshakeChannel; signal: AbortSignal; responseTimeoutMs: number;
}): Promise<NaidanPipingKeyContext> {
  // Keep the existing pinned-only entrypoint incapable of silently trusting a new key.
  return establishVerifiedNaidanPipingKeys({ role, identity, expectedPeer, verifyPeer: undefined, binding, channel, signal, responseTimeoutMs, onResponseFailure: undefined }).then(({ keys }) => keys);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  verifyComparison,
};
