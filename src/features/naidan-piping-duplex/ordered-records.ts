import { ascii, MAX_OFFSET, ownBytes, requireValue, u64 } from '@/features/naidan-piping-duplex/bytes';
import { BATCH_BYTES, BATCH_HEADER_BYTES, CIPHERTEXT_BYTES, PLAINTEXT_BYTES, RECORDS_PER_BATCH, batchHeader, inspectBatchHeader } from '@/features/naidan-piping-duplex/batch-wire';
import type { NaidanPipingDirection, NaidanPipingKeyDomain } from '@/features/naidan-piping-duplex/key-context';
import type { BoundedBody } from '@/features/naidan-piping-duplex/finite-transfer';
import { RecordExhaustedError } from '@/features/naidan-piping-duplex/lifetime';

const EPOCH_RECORDS = 16_384n;
const AAD_DOMAIN = ascii({ text: 'naidan-piping-duplex/v1/records' });

/** Appendix A uses length-prefixed fields, without the older fields() field-count prefix. */
function recordAad({ context, direction, header, batch, record, index, length }: {
  context: Uint8Array; direction: NaidanPipingDirection; header: Uint8Array;
  batch: bigint; record: bigint; index: number; length: number;
}): Uint8Array<ArrayBuffer> {
  const position = new Uint8Array(2), size = new Uint8Array(4);
  new DataView(position.buffer).setUint16(0, index); new DataView(size.buffer).setUint32(0, length);
  const parts = [AAD_DOMAIN, context, new Uint8Array([direction]), header, u64({ value: batch }), u64({ value: record }), position, size];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + 2 + part.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const part of parts) {
    view.setUint16(offset, part.length); bytes.set(part, offset + 2); offset += part.length + 2;
  }
  return bytes;
}

/** Exactly one ordered direction. Any failed operation poisons this codec; no retries or old-key cache. */
export class OrderedRecords {
  private record = 0n;
  private batch = 0n;
  private key: { epoch: bigint; value: CryptoKey } | undefined;
  private busy = false;
  private disposed = false;
  private readonly context: Uint8Array;
  private readonly domain: NaidanPipingKeyDomain;
  private readonly direction: NaidanPipingDirection;
  private readonly usage: 'encrypt' | 'decrypt';
  constructor({ domain, context, direction, usage }: {
    domain: NaidanPipingKeyDomain; context: Uint8Array; direction: NaidanPipingDirection; usage: 'encrypt' | 'decrypt';
  }) {
    this.context = ownBytes({ bytes: context, maxBytes: 32 });
    requireValue({ condition: this.context.length === 32, message: 'Invalid record context' });
    domain.claimRecordOwner({ direction, usage, context: this.context });
    this.domain = domain; this.direction = direction; this.usage = usage;
  }
  dispose(): void {
    this.disposed = true; this.key = undefined; this.context.fill(0);
  }
  private live({ signal }: { signal: AbortSignal }): void {
    signal.throwIfAborted(); requireValue({ condition: !this.disposed, message: 'Record codec disposed' }); this.domain.assertActive();
  }
  private start({ usage, signal }: { usage: 'encrypt' | 'decrypt'; signal: AbortSignal }): void {
    this.live({ signal });
    requireValue({ condition: !this.busy && this.usage === usage, message: 'Record codec already owned or wrong direction' });
    if (this.batch > MAX_OFFSET || this.record > MAX_OFFSET) {
      this.dispose(); throw new RecordExhaustedError();
    }
    this.busy = true;
  }
  async nextRoute({ signal }: { signal: AbortSignal }): Promise<string> {
    this.live({ signal });
    if (this.batch > MAX_OFFSET) throw new RecordExhaustedError();
    const route = await this.domain.batchRoute({ direction: this.direction, number: this.batch });
    this.live({ signal }); return route;
  }
  private async crypt({ bytes, header, batch, record, index, length, signal }: {
    bytes: Uint8Array<ArrayBuffer>; header: Uint8Array; batch: bigint; record: bigint; index: number; length: number; signal: AbortSignal;
  }): Promise<Uint8Array<ArrayBuffer>> {
    this.live({ signal });
    const epoch = record / EPOCH_RECORDS;
    if (this.key?.epoch !== epoch) {
      const value = await this.domain.aead({ direction: this.direction, epoch, usage: this.usage });
      this.live({ signal }); this.key = { epoch, value };
    }
    const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, record % EPOCH_RECORDS);
    const additionalData = recordAad({ context: this.context, direction: this.direction, header, batch, record, index, length });
    const result = new Uint8Array(await crypto.subtle[this.usage]({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, this.key.value, bytes));
    try {
      this.live({ signal }); return result;
    } catch (error) {
      result.fill(0); throw error;
    }
  }
  async seal({ plaintexts, signal }: { plaintexts: readonly Uint8Array[]; signal: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> {
    this.start({ usage: 'encrypt', signal });
    const snapshots: Uint8Array<ArrayBuffer>[] = [];
    try {
      requireValue({ condition: plaintexts.length > 0 && plaintexts.length <= RECORDS_PER_BATCH, message: 'Invalid batch record count' });
      if (this.record + BigInt(plaintexts.length) - 1n > MAX_OFFSET) throw new RecordExhaustedError();
      requireValue({ condition: this.batch !== 0n || plaintexts.length === 1, message: 'Initial batch must contain one READY record' });
      let size = BATCH_HEADER_BYTES;
      for (const plain of plaintexts) {
        requireValue({ condition: plain.length > 0 && plain.length <= PLAINTEXT_BYTES, message: 'Invalid record plaintext' });
        size += 4 + 16 + plain.length;
      }
      requireValue({ condition: size <= BATCH_BYTES, message: 'Batch exceeds byte limit' });
      for (const plain of plaintexts) snapshots.push(ownBytes({ bytes: plain, maxBytes: PLAINTEXT_BYTES }));
      const header = batchHeader({ count: snapshots.length }), bytes = new Uint8Array(size);
      bytes.set(header); const view = new DataView(bytes.buffer); let offset = BATCH_HEADER_BYTES;
      const first = this.record, batch = this.batch;
      // Reserve every nonce before the first native operation. A failure cannot reset either counter.
      this.record += BigInt(snapshots.length); this.batch++;
      for (let index = 0; index < snapshots.length; index++) {
        const plain = snapshots[index]!, length = plain.length + 16;
        const encrypted = await this.crypt({ bytes: plain, header, batch, record: first + BigInt(index), index, length, signal });
        view.setUint32(offset, length); bytes.set(encrypted, offset + 4); offset += 4 + length;
      }
      return bytes;
    } catch (error) {
      this.dispose(); throw error;
    } finally {
      for (const snapshot of snapshots) snapshot.fill(0); this.busy = false;
    }
  }
  async receive({ body, signal, onRecord }: {
    body: BoundedBody; signal: AbortSignal; onRecord({ plaintext, first }: { plaintext: Uint8Array; first: boolean }): Promise<void>;
  }): Promise<void> {
    this.start({ usage: 'decrypt', signal });
    try {
      const header = await body.take({ size: BATCH_HEADER_BYTES }), count = inspectBatchHeader({ header });
      requireValue({ condition: this.batch !== 0n || count === 1, message: 'Initial batch must contain one READY record' });
      if (this.record + BigInt(count) - 1n > MAX_OFFSET) throw new RecordExhaustedError();
      let total = BATCH_HEADER_BYTES;
      for (let index = 0; index < count; index++) {
        const prefix = await body.take({ size: 4 }), length = new DataView(prefix.buffer).getUint32(0);
        requireValue({ condition: length >= 16 && length <= CIPHERTEXT_BYTES && total + length + 4 <= BATCH_BYTES, message: 'Invalid ciphertext length' });
        total += length + 4;
        const encrypted = await body.take({ size: length });
        const plaintext = await this.crypt({ bytes: encrypted, header, batch: this.batch, record: this.record, index, length, signal });
        this.record++;
        try {
          await onRecord({ plaintext, first: this.batch === 0n && index === 0 });
        } finally {
          plaintext.fill(0);
        }
        this.live({ signal });
      }
      await body.end(); this.live({ signal }); this.batch++;
    } catch (error) {
      this.dispose(); throw error;
    } finally {
      this.busy = false;
    }
  }
}

export const TEST_ONLY = {
  recordAad,
};
