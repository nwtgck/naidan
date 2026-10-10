import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { ascii, ownBytes, joinBytes, u64, requireValue } from '@/features/naidan-piping-duplex/bytes';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type NaidanPipingIdentity = {
    privateKey: CryptoKey;
    publicKey: Uint8Array;
};

export async function createNaidanPipingIdentity(): Promise<NaidanPipingIdentity> {
  const keys = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  if (!('privateKey' in keys))
    throw new Error('Expected X25519 key pair');
  return { privateKey: keys.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)) };
}

async function hash({ bytes }: {
    bytes: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

async function hkdf2({ chaining, input }: {
    chaining: Uint8Array;
    input: Uint8Array;
}): Promise<[
    Uint8Array,
    Uint8Array
]> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(input), 'HKDF', false, ['deriveBits']);
  const result = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(chaining),
    info: new Uint8Array(),
  }, key, 512));
  const pair: [
        Uint8Array,
        Uint8Array
    ] = [result.slice(0, 32), result.slice(32)];
  result.fill(0);
  return pair;
}

async function aeadKey({ bytes }: {
    bytes: Uint8Array;
}): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export class NoiseCipher {
  private internalKey: CryptoKey | undefined;
  private internalNonce = 0n;
  private internalBusy = false;
  private internalClosed = false;

  constructor({ key }: {
        key: CryptoKey;
    }) {
    this.internalKey = key;
  }

  dispose(): void {
    this.internalClosed = true; this.internalKey = undefined;
  }

  async crypt({ operation, bytes, aad }: {
        operation: 'encrypt' | 'decrypt';
        bytes: Uint8Array;
        aad: Uint8Array;
    }): Promise<Uint8Array<ArrayBuffer>> {
    requireValue({ condition: !this.internalBusy && !this.internalClosed && this.internalNonce < (1n << 64n) - 1n, message: 'Cipher unavailable' });
    const input = ownBytes({ bytes, maxBytes: isEncrypt({ operation }) ? 65519 : 65535 }), additionalData = ownBytes({ bytes: aad, maxBytes: 65535 });
    this.internalBusy = true;
    const nonce = this.internalNonce;
    const key = this.internalKey;
    if (!key)
      throw new Error('Cipher disposed');
    // Encryption failures consume the number and terminate this cipher.
    if (isEncrypt({ operation }))
      this.internalNonce++;
    try {
      const params = { name: 'AES-GCM', iv: joinBytes({ parts: [new Uint8Array(4), u64({ value: nonce })] }), additionalData, tagLength: 128 };
      const result = new Uint8Array(await crypto.subtle[operation](params, key, input));
      if (this.internalClosed)
        throw new Error('Cipher disposed');
      if (!isEncrypt({ operation }))
        this.internalNonce++;
      return result;
    } catch (error) {
      if (isEncrypt({ operation }))
        this.internalClosed = true;
      throw error;
    } finally {
      this.internalBusy = false;
    }
  }
}
export class NoiseXX {
  private internalRole: NaidanPipingRole;
  private internalIdentity: NaidanPipingIdentity | undefined;
  private internalEphemeral: NaidanPipingIdentity | undefined;
  private internalRemoteEphemeral: Uint8Array | undefined;
  private internalRemoteStatic: Uint8Array | undefined;
  private internalChaining: Uint8Array;
  private internalHash: Uint8Array;
  private internalCipher: NoiseCipher | undefined;
  private internalStep = 0;
  private internalBusy = false;
  private internalFailed = false;
  private internalSplitUsed = false;

  private constructor({ role, identity, ephemeral, initialHash }: {
        role: NaidanPipingRole;
        identity: NaidanPipingIdentity;
        ephemeral: NaidanPipingIdentity;
        initialHash: Uint8Array;
    }) {
    this.internalRole = role;
    this.internalIdentity = identity;
    this.internalEphemeral = ephemeral;
    this.internalChaining = initialHash.slice();
    this.internalHash = initialHash.slice();
  }

  static async create({ role, identity, ephemeral, prologue }: {
        role: NaidanPipingRole;
        identity: NaidanPipingIdentity;
        ephemeral: NaidanPipingIdentity;
        prologue: Uint8Array;
    }): Promise<NoiseXX> {
    requireValue({ condition: isInitiator({ role: role }) || !isInitiator({ role: role }), message: 'Invalid role' });
    const publicKey = ownBytes({ bytes: identity.publicKey, maxBytes: 32 });
    const ephemeralPublic = ownBytes({ bytes: ephemeral.publicKey, maxBytes: 32 });
    const input = ownBytes({ bytes: prologue, maxBytes: 4096 });
    requireValue({ condition: publicKey.length === 32 && ephemeralPublic.length === 32, message: 'X25519 key size' });
    const name = ascii({ text: 'Noise_XX_25519_AESGCM_SHA256' });
    const initialHash = name.length <= 32 ? joinBytes({ parts: [name, new Uint8Array(32 - name.length)] }) : await hash({ bytes: name });
    const state = new NoiseXX({
      role,
      identity: { privateKey: identity.privateKey, publicKey },
      ephemeral: { privateKey: ephemeral.privateKey, publicKey: ephemeralPublic },
      initialHash,
    });
    await state.internalMixHash({ bytes: input });
    return state;
  }

  private async internalMixHash({ bytes }: {
        bytes: Uint8Array;
    }): Promise<void> {
    this.internalHash = await hash({ bytes: joinBytes({ parts: [this.internalHash, bytes] }) });
  }

  private async internalMixDh({ privateKey, publicKey }: {
        privateKey: CryptoKey;
        publicKey: Uint8Array | undefined;
    }): Promise<void> {
    if (!publicKey)
      throw new Error('Missing remote key');
    const peer = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), 'X25519', false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256));
    try {
      const [chaining, material] = await hkdf2({ chaining: this.internalChaining, input: secret });
      this.internalChaining.fill(0);
      this.internalChaining = chaining;
      const key = await aeadKey({ bytes: material });
      material.fill(0);
      this.internalCipher = new NoiseCipher({ key });
    } finally {
      secret.fill(0);
    }
  }

  private async internalField({ operation, bytes }: {
        operation: 'encrypt' | 'decrypt';
        bytes: Uint8Array;
    }): Promise<Uint8Array<ArrayBuffer>> {
    const result = this.internalCipher ? await this.internalCipher.crypt({ operation, bytes, aad: this.internalHash }) : bytes.slice();
    await this.internalMixHash({ bytes: isEncrypt({ operation }) ? result : bytes });
    return result;
  }

  get peerIdentity(): Uint8Array | undefined {
    requireValue({ condition: !this.internalFailed && !this.internalBusy, message: 'Handshake unavailable' });
    return this.internalRemoteStatic?.slice();
  }

  dispose(): void {
    this.internalFailed = true;
    this.internalChaining.fill(0);
    this.internalCipher?.dispose();
    this.internalCipher = undefined;
    this.internalIdentity = undefined;
    this.internalEphemeral = undefined;
  }

  async exchange({ operation, bytes }: {
        operation: 'write' | 'read';
        bytes: Uint8Array;
    }): Promise<Uint8Array<ArrayBuffer>> {
    requireValue({ condition: !this.internalBusy && !this.internalFailed && this.internalStep < 3, message: 'Handshake unavailable' });
    const identity = this.internalIdentity, ephemeral = this.internalEphemeral;
    if (!identity || !ephemeral)
      throw new Error('Handshake disposed');
    const initiator = isInitiator({ role: this.internalRole });
    const writeExpected = this.internalStep === 1 ? !initiator : initiator;
    requireValue({ condition: (isWrite({ operation })) === writeExpected, message: 'Wrong handshake flight' });
    const input = ownBytes({ bytes, maxBytes: 512 });
    this.internalBusy = true;
    try {
      let at = 0;
      const output: Uint8Array[] = [];
      const take = ({ count }: {
                count: number;
            }) => {
        requireValue({ condition: at + count <= input.length, message: 'Truncated handshake' });
        const part = input.slice(at, at + count);
        at += count;
        return part;
      };
      if (this.internalStep < 2) {
        if (isWrite({ operation })) {
          output.push(ephemeral.publicKey);
          await this.internalMixHash({ bytes: ephemeral.publicKey });
        } else {
          this.internalRemoteEphemeral = take({ count: 32 });
          await this.internalMixHash({ bytes: this.internalRemoteEphemeral });
        }
      }
      if (this.internalStep === 1)
        await this.internalMixDh({ privateKey: ephemeral.privateKey, publicKey: this.internalRemoteEphemeral });
      if (this.internalStep > 0) {
        if (isWrite({ operation }))
          output.push(await this.internalField({ operation: 'encrypt', bytes: identity.publicKey }));
        else
          this.internalRemoteStatic = await this.internalField({ operation: 'decrypt', bytes: take({ count: 48 }) });
        const useEphemeral = (this.internalStep === 1) === initiator;
        await this.internalMixDh({
          privateKey: useEphemeral ? ephemeral.privateKey : identity.privateKey,
          publicKey: useEphemeral ? this.internalRemoteStatic : this.internalRemoteEphemeral,
        });
      }
      const payload = await this.internalField({
        operation: isWrite({ operation }) ? 'encrypt' : 'decrypt',
        bytes: isWrite({ operation }) ? input : input.slice(at),
      });
      if (this.internalFailed)
        throw new Error('Handshake disposed');
      const message = isWrite({ operation }) ? joinBytes({ parts: [...output, payload] }) : payload;
      requireValue({ condition: message.length <= 512, message: 'Handshake message limit' });
      this.internalStep++;
      return message;
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      this.internalBusy = false;
    }
  }

  async split(): Promise<{
        send: NoiseCipher;
        receive: NoiseCipher;
        binding: Uint8Array;
        peerIdentity: Uint8Array;
    }> {
    if (this.internalStep !== 3 || this.internalFailed || this.internalBusy || this.internalSplitUsed || !this.internalRemoteStatic)
      throw new Error('Handshake incomplete/consumed');
    this.internalSplitUsed = true;
    let first: Uint8Array | undefined, second: Uint8Array | undefined;
    try {
      [first, second] = await hkdf2({ chaining: this.internalChaining, input: new Uint8Array() });
      this.internalChaining.fill(0);
      const firstKey = await aeadKey({ bytes: first }), secondKey = await aeadKey({ bytes: second });
      first.fill(0);
      second.fill(0);
      requireValue({ condition: !this.internalFailed, message: 'Handshake disposed during split' });
      return {
        send: new NoiseCipher({ key: isInitiator({ role: this.internalRole }) ? firstKey : secondKey }),
        receive: new NoiseCipher({ key: isInitiator({ role: this.internalRole }) ? secondKey : firstKey }),
        binding: this.internalHash.slice(),
        peerIdentity: this.internalRemoteStatic.slice(),
      };
    } finally {
      first?.fill(0);
      second?.fill(0);
      this.dispose();
    }
  }
}



function isEncrypt({ operation }: { operation: 'encrypt' | 'decrypt' }): boolean {
  switch (operation) {
  case 'encrypt': return true;
  case 'decrypt': return false;
  default: { const unreachable: never = operation; throw new Error(`Invalid cipher operation: ${unreachable}`); }
  }
}

function isWrite({ operation }: { operation: 'write' | 'read' }): boolean {
  switch (operation) {
  case 'write': return true;
  case 'read': return false;
  default: { const unreachable: never = operation; throw new Error(`Invalid handshake operation: ${unreachable}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
