import { CAPSULE_BYTES, MAX_OFFSET, ownBytes, fields, ascii, u64, joinBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { decodeSnapshot } from '@/features/naidan-piping-duplex/wire';
import type { Snapshot } from '@/features/naidan-piping-duplex/wire';
import type { NaidanPipingKeyDomain, NaidanPipingDirection } from '@/features/naidan-piping-duplex/key-context';
const FAILED_AUTHENTICATION_LIMIT = 65536;
export class Records {
  private internalDomain: NaidanPipingKeyDomain;
  private internalContext: Uint8Array;
  private internalDirection: NaidanPipingDirection;
  private internalUsage: 'encrypt' | 'decrypt';
  private internalNext = 0n;
  private internalHigh = -1n;
  private internalBusy = false;
  private internalFailedAuthentications = 0;
  private internalVerifications = 0;
  private internalKeys = new Map<bigint, CryptoKey>();
  constructor({ domain, context, direction, usage }: {
        domain: NaidanPipingKeyDomain;
        context: Uint8Array;
        direction: NaidanPipingDirection;
        usage: 'encrypt' | 'decrypt';
    }) {
    requireValue({ condition: context.length === 32, message: 'Record context must be 32 bytes' });
    domain.claimRecordOwner({ direction, usage, context });
    this.internalDomain = domain;
    this.internalContext = ownBytes({ bytes: context, maxBytes: 32 });
    this.internalDirection = direction;
    this.internalUsage = usage;
  }
  get next(): bigint {
    return this.internalNext;
  }
  get high(): bigint {
    return this.internalHigh;
  }
  private async internalKey({ number }: {
        number: bigint;
    }): Promise<CryptoKey> {
    this.internalDomain.assertActive();
    const epoch = number / 16384n;
    return this.internalKeys.get(epoch) ?? await this.internalDomain.aead({ direction: this.internalDirection, epoch, usage: this.internalUsage });
  }
  private internalRemember({ number, key }: {
        number: bigint;
        key: CryptoKey;
    }): void {
    const epoch = number / 16384n;
    if (!this.internalKeys.has(epoch) && this.internalKeys.size >= 2) {
      const oldest = this.internalKeys.keys().next().value;
      if (oldest !== undefined)
        this.internalKeys.delete(oldest);
    }
    this.internalKeys.set(epoch, key);
  }
  private internalParams({ number, header }: {
        number: bigint;
        header: Uint8Array;
    }): AesGcmParams {
    return { name: 'AES-GCM', iv: joinBytes({ parts: [new Uint8Array(4), u64({ value: number % 16384n })] }), tagLength: 128,
      additionalData: fields({ parts: [ascii({ text: 'piping-duplex-record/v2' }), this.internalContext, new Uint8Array([this.internalDirection]), header] }) };
  }
  async seal({ plaintext }: {
        plaintext: Uint8Array;
    }): Promise<Uint8Array> {
    requireValue({ condition: this.internalUsage === 'encrypt' && !this.internalBusy && this.internalNext <= MAX_OFFSET, message: 'Record writer unavailable' });
    const bytes = ownBytes({ bytes: plaintext, maxBytes: CAPSULE_BYTES - 25 });
    const number = this.internalNext++;
    this.internalBusy = true;
    try {
      const header = joinBytes({ parts: [new Uint8Array([2]), u64({ value: number })] });
      const key = await this.internalKey({ number });
      const body = new Uint8Array(await crypto.subtle.encrypt(this.internalParams({ number, header }), key, bytes));
      this.internalDomain.assertActive();
      this.internalRemember({ number, key });
      return joinBytes({ parts: [header, body] });
    } finally {
      this.internalBusy = false;
    }
  }
  async accept({ capsule, apply }: {
        capsule: Uint8Array;
        apply: ({ snapshot }: {
            snapshot: Snapshot;
        }) => undefined;
    }): Promise<'accepted' | 'stale' | 'unauthenticated'> {
    requireValue({ condition: this.internalUsage === 'decrypt', message: 'Record reader unavailable' });
    if (!(capsule instanceof Uint8Array) || !(capsule.buffer instanceof ArrayBuffer) || capsule.byteLength > CAPSULE_BYTES)
      return 'unauthenticated';
    const bytes = ownBytes({ bytes: capsule, maxBytes: CAPSULE_BYTES });
    if (bytes.length < 25 || bytes[0] !== 2)
      return 'unauthenticated';
    const number = new DataView(bytes.buffer).getBigUint64(1, false);
    if (number > MAX_OFFSET)
      return 'unauthenticated';
    // Reserve before any await so concurrent verification cannot overspend the failure budget.
    requireValue({ condition: this.internalFailedAuthentications + this.internalVerifications < FAILED_AUTHENTICATION_LIMIT,
      message: 'Authentication verification budget exhausted' });
    this.internalVerifications++;
    let plaintext: Uint8Array, key: CryptoKey;
    try {
      key = await this.internalKey({ number });
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt(this.internalParams({ number, header: bytes.subarray(0, 9) }), key, bytes.subarray(9)));
      } catch {
        this.internalFailedAuthentications++;
        requireValue({ condition: this.internalFailedAuthentications < FAILED_AUTHENTICATION_LIMIT,
          message: 'Authentication verification budget exhausted' });
        return 'unauthenticated';
      }
    } finally {
      this.internalVerifications--;
    }
    // Success or an epoch change never resets failed-authentication accounting.
    // Recheck after asynchronous cryptography. No await in parse / semantic commit.
    this.internalDomain.assertActive();
    if (number <= this.internalHigh)
      return 'stale';
    const snapshot = decodeSnapshot({ bytes: plaintext });
    apply({ snapshot });
    this.internalHigh = number;
    this.internalRemember({ number, key });
    return 'accepted';
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
