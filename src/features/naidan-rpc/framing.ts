import { z } from 'zod';
import { decode, encode } from '@/features/naidan-rpc/codec';
import type { WireValue } from '@/features/naidan-rpc/codec';
import { check, codes, deferred, FRAME_BYTES, QUEUE_BYTES, QUEUE_FRAMES, TRANSFER_BYTES, VALUE_BYTES, NaidanRpcError, NaidanRpcPublicError, publicErrorDetailsSchema, RPC_VERSION } from '@/features/naidan-rpc/primitives';
import { references } from './schema';
import { ByteAssembly } from './assembly';
import type { NaidanRpcDuplex } from '@/features/naidan-rpc/transport';

const id = z.number().int().min(1).max(65535), sequence = z.number().int().min(1).max(0xffffffff);
const scope = z.enum(['input', 'result']);
export const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), version: z.literal(RPC_VERSION), contract: z.string().max(64), method: z.string().max(64), timeoutMs: z.number().int().positive().max(2147483647).optional(), value: z.unknown() }),
  z.object({ type: z.literal('result'), value: z.unknown() }),
  z.object({ type: z.literal('accept'), scope, ids: z.array(id).max(16) }),
  z.object({ type: z.literal('pull'), id, sequence }),
  z.object({ type: z.literal('item'), id, sequence, value: z.unknown() }),
  z.object({ type: z.literal('item-fragment'), id, sequence, total: z.number().int().min(1).max(VALUE_BYTES), offset: z.number().int().nonnegative().max(VALUE_BYTES), data: z.instanceof(Uint8Array).refine(bytes => bytes.length > 0 && bytes.length <= TRANSFER_BYTES) }),
  z.object({ type: z.literal('end'), id, sequence }),
  z.object({ type: z.literal('stop'), id }),
  z.object({ type: z.literal('stopped'), id }),
  z.object({ type: z.literal('invoke'), id, invocation: sequence, value: z.unknown() }),
  z.object({ type: z.literal('returned'), invocation: sequence, value: z.unknown() }),
  z.object({ type: z.literal('raised'), invocation: sequence }),
  z.object({ type: z.literal('notice'), name: z.string().max(64), value: z.unknown() }),
  z.object({ type: z.literal('finish'), code: z.enum(codes).optional(), details: publicErrorDetailsSchema.optional() })
    .refine(value => value.code !== undefined || value.details === undefined),
  z.object({ type: z.literal('ack') }),
]);
export type Frame = z.output<typeof frameSchema>;
type Pending = { bytes: Uint8Array; settled: ReturnType<typeof deferred<void>> };

export class FramedDuplex {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private sending = false;
  private sendWork: Promise<void> = Promise.resolve();
  private closing = false;
  private failure: unknown;
  private readonly drained = deferred<void>();
  private chunk: Uint8Array = new Uint8Array();
  private cursor = 0;
  constructor({ duplex }: { duplex: NaidanRpcDuplex }) {
    this.reader = duplex.readable.getReader();
    try {
      this.writer = duplex.writable.getWriter();
    } catch (error) {
      this.reader.releaseLock(); throw error;
    }
  }
  send({ frame }: { frame: Frame }): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    check({ condition: !this.closing, code: 'RESOURCE_EXHAUSTED' });
    if (this.queue.length >= QUEUE_FRAMES) throw new NaidanRpcPublicError({
      code: 'RESOURCE_EXHAUSTED',
      details: {
        scope: 'rpc-frame',
        constraint: 'queued-frames',
        limit: QUEUE_FRAMES,
        observed: this.queue.length + 1,
      },
    });
    const payload = encode({ value: frameSchema.parse(frame), limit: FRAME_BYTES });
    const bytes = new Uint8Array(payload.length + 4); new DataView(bytes.buffer).setUint32(0, payload.length, false); bytes.set(payload, 4);
    if (this.queuedBytes + bytes.length > QUEUE_BYTES) throw new NaidanRpcPublicError({
      code: 'RESOURCE_EXHAUSTED',
      details: {
        scope: 'rpc-frame',
        constraint: 'queued-bytes',
        limit: QUEUE_BYTES,
        observed: this.queuedBytes + bytes.length,
      },
    });
    const settled = deferred<void>(); this.queue.push({ bytes, settled }); this.queuedBytes += bytes.length;
    this.kick(); return settled.promise;
  }
  private kick(): void {
    if (!this.sending) this.sendWork = this.pump();
  }
  private async pump(): Promise<void> {
    if (this.sending) return; this.sending = true;
    try {
      while (this.queue.length) {
        const next = this.queue[0]!;
        for (let offset = 0; offset < next.bytes.length; offset += TRANSFER_BYTES) {
          await this.writer.write(next.bytes.subarray(offset, offset + TRANSFER_BYTES));
          if (this.failure) return;
        }
        if (this.failure) return;
        this.queue.shift(); this.queuedBytes -= next.bytes.length; next.settled.resolve();
      }
      if (this.closing) {
        await this.writer.close(); this.drained.resolve();
      }
    } catch (error) {
      this.failure = error; this.rejectQueue({ error });
    } finally {
      this.sending = false;
    }
  }
  finish(): Promise<void> {
    if (!this.closing) {
      this.closing = true; this.kick();
    }
    return this.drained.promise;
  }
  private rejectQueue({ error }: { error: unknown }): void {
    for (const entry of this.queue.splice(0)) entry.settled.reject(error);
    this.queuedBytes = 0; this.drained.reject(error);
  }
  async stop({ error }: { error: unknown }): Promise<void> {
    this.failure = error; this.rejectQueue({ error });
    await Promise.allSettled([this.reader.cancel(error), this.writer.abort(error), this.sendWork]);
  }
  release(): void {
    try {
      this.reader.releaseLock();
    } catch { /* Pending platform operation still owns its lock. */ }
    try {
      this.writer.releaseLock();
    } catch { /* Pending platform operation still owns its lock. */ }
    this.chunk = new Uint8Array();
  }
  private async bytes({ length, allowEnd }: { length: number; allowEnd: boolean }): Promise<Uint8Array | undefined> {
    const bytes = new ByteAssembly({ limit: length }); let written = 0;
    while (written < length) {
      if (this.cursor === this.chunk.length) {
        const next = await this.reader.read();
        if (next.done) {
          if (allowEnd && written === 0) return undefined;
          throw new NaidanRpcError({ code: 'PROTOCOL_ERROR' });
        }
        check({ condition: next.value instanceof Uint8Array && next.value.buffer instanceof ArrayBuffer && next.value.length > 0, code: 'PROTOCOL_ERROR' });
        this.chunk = next.value; this.cursor = 0;
      }
      const size = Math.min(length - written, this.chunk.length - this.cursor);
      bytes.append({ bytes: this.chunk.subarray(this.cursor, this.cursor + size) }); this.cursor += size; written += size;
    }
    return bytes.finish();
  }
  async read(): Promise<Frame | undefined> {
    const header = await this.bytes({ length: 4, allowEnd: true }); if (!header) return undefined;
    const length = new DataView(header.buffer).getUint32(0, false);
    check({ condition: length > 0 && length <= FRAME_BYTES, code: 'PROTOCOL_ERROR' });
    const body = await this.bytes({ length, allowEnd: false });
    if (!body) throw new Error('Missing frame');
    const raw = decode({ bytes: body });
    // Inspect before stripping extensions: hidden/duplicate capabilities must
    // not escape direction, ownership or acceptance checks.
    const all = references({ value: raw });
    const frame = frameSchema.parse(raw);
    const payload = 'value' in frame ? wireValue({ value: frame.value }) : undefined;
    const allowed = references({ value: payload });
    check({ condition: all.size === allowed.size && [...all].every(([id, reference]) => allowed.get(id)?.mode === reference.mode), code: 'PROTOCOL_ERROR' });
    return frame;
  }
}
export function wireValue({ value }: { value: unknown }): WireValue {
  // Parsed frames contain only this codec's closed value set. Clone through it at application boundaries.
  return decode({ bytes: encode({ value, limit: FRAME_BYTES }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
