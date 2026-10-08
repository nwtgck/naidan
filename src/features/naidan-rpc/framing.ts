import { encodeProtocolHeader, ProtocolHeaderReader } from './protocol-header';
import type { ProtocolHeaderResult } from './protocol-header';
import { abortWriter, cancelReader, releaseLocks, RetirementFailures } from '@/features/naidan-rpc/stream-retirement';
import { z } from 'zod';
import { decode, encode } from '@/features/naidan-rpc/codec';
import type { WireValue } from '@/features/naidan-rpc/codec';
import { check, codes, deferred, FRAME_BYTES, QUEUE_BYTES, QUEUE_FRAMES, TRANSFER_BYTES, VALUE_BYTES, NaidanRpcError, NaidanRpcPublicError, publicErrorDetailsSchema, NaidanRpcProtocolError } from '@/features/naidan-rpc/primitives';
import { references } from './schema';
import { ByteAssembly } from './assembly';
import type { NaidanRpcDuplex } from '@/features/naidan-rpc/transport';

const id = z.number().int().min(1).max(65535), sequence = z.number().int().min(1).max(0xffffffff);
const scope = z.enum(['input', 'result']);
export const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), contract: z.string().max(64), method: z.string().max(64), timeoutMs: z.number().int().positive().max(2147483647).optional(), value: z.unknown() }),
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
type Pending = { bytes: Uint8Array; offset: number; settled: ReturnType<typeof deferred<void>> };

export class FramedDuplex {
  readonly preambleSent: Promise<void>;
  private preambleRead: Promise<void> | undefined;
  private readonly onProtocolFailure: ({ error }: { error: NaidanRpcProtocolError }) => void;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly queue: Pending[] = [];
  // Entries own distinct backing buffers. Offsets never refund retained capacity;
  // an active write keeps its entries charged even after logical queue rejection.
  private retainedBytes = 0;
  private inFlight: { entries: Pending[]; bytes: Uint8Array; scratchBytes: number } | undefined;
  private sending = false;
  private sendWork: Promise<void> = Promise.resolve();
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private failure: { error: unknown } | undefined;
  private readonly drained = deferred<void>();
  private chunk: Uint8Array = new Uint8Array();
  private cursor = 0;
  private stopped = false;
  private released = false;
  private retirement: Promise<void> | undefined;
  private readonly reads = new Set<Promise<Frame | undefined>>();
  private readonly onRetirementFailure: (({ error }: { error: unknown }) => void) | undefined;
  constructor({ duplex, onRetirementFailure, onProtocolFailure }: { duplex: NaidanRpcDuplex; onProtocolFailure: ({ error }: { error: NaidanRpcProtocolError }) => void; onRetirementFailure?: ({ error }: { error: unknown }) => void }) {
    this.onRetirementFailure = onRetirementFailure; this.onProtocolFailure = onProtocolFailure;
    this.reader = duplex.readable.getReader();
    try {
      this.writer = duplex.writable.getWriter();
    } catch (error) {
      releaseLocks({ reader: this.reader, writer: undefined });
      throw error;
    }
    const settled = deferred<void>(), bytes = encodeProtocolHeader();
    this.preambleSent = settled.promise;
    this.queue.push({ bytes, offset: 0, settled }); this.retainedBytes = bytes.buffer.byteLength;
    this.kick();
  }
  send({ frame }: { frame: Frame }): Promise<void> {
    if (this.retirement || this.released || this.failure) return Promise.reject(this.failure ? this.failure.error : new NaidanRpcError({ code: 'CANCELLED' }));
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
    if (this.retainedBytes + bytes.buffer.byteLength > QUEUE_BYTES) throw new NaidanRpcPublicError({
      code: 'RESOURCE_EXHAUSTED',
      details: {
        scope: 'rpc-frame',
        constraint: 'queued-bytes',
        limit: QUEUE_BYTES,
        observed: this.retainedBytes + bytes.buffer.byteLength,
      },
    });
    const settled = deferred<void>(); this.queue.push({ bytes, offset: 0, settled }); this.retainedBytes += bytes.buffer.byteLength;
    this.kick(); return settled.promise;
  }
  private kick(): void {
    if (this.sending) return;
    // Publish ownership before a lower write/close can synchronously reenter stop.
    const work = deferred<void>(); this.sendWork = work.promise;
    void this.pump().then(work.resolve, work.reject);
  }
  private async pump(): Promise<void> {
    if (this.sending) return; this.sending = true;
    try {
      while (this.queue.length) {
        const prefix = this.readyPrefix(); this.inFlight = prefix;
        try {
          await this.writer.write(prefix.bytes);
          if (this.stopped || this.failure) return;
          let remaining = prefix.bytes.length;
          for (const entry of prefix.entries) {
            const size = Math.min(remaining, entry.bytes.length - entry.offset);
            entry.offset += size; remaining -= size;
            if (entry.offset === entry.bytes.length) {
              this.queue.shift(); this.retainedBytes -= entry.bytes.buffer.byteLength; entry.settled.resolve();
            }
          }
        } finally {
          // A rejected queue transferred these still-owned buffers to this write.
          // Neither stop nor a late success/rejection can release them twice.
          if (this.stopped || this.failure) {
            for (const entry of prefix.entries) this.retainedBytes -= entry.bytes.buffer.byteLength;
          }
          this.inFlight = undefined;
        }
      }
      if (this.closing) {
        this.closeWork = this.writer.close(); await this.closeWork; this.drained.resolve();
      }
    } catch (error) {
      this.failure ??= { error }; this.rejectQueue({ error: this.failure.error });
    } finally {
      this.sending = false;
    }
  }
  private readyPrefix(): { entries: Pending[]; bytes: Uint8Array; scratchBytes: number } {
    const entries: Pending[] = []; let length = 0;
    for (const entry of this.queue) {
      entries.push(entry); length += Math.min(TRANSFER_BYTES - length, entry.bytes.length - entry.offset);
      if (length === TRANSFER_BYTES) break;
    }
    const first = entries[0]!;
    if (entries.length === 1) return { entries, bytes: first.bytes.subarray(first.offset, first.offset + length), scratchBytes: 0 };
    // One independent, bounded scratch allowance; never wait for queue capacity
    // in the pump that must drain that queue. No delay to create a larger batch.
    const bytes = new Uint8Array(length); let offset = 0;
    for (const entry of entries) {
      const size = Math.min(length - offset, entry.bytes.length - entry.offset);
      bytes.set(entry.bytes.subarray(entry.offset, entry.offset + size), offset); offset += size;
    }
    return { entries, bytes, scratchBytes: bytes.buffer.byteLength };
  }
  finish(): Promise<void> {
    if (this.stopped || this.failure) return Promise.reject(this.failure ? this.failure.error : new NaidanRpcError({ code: 'CANCELLED' }));
    if (!this.closing) {
      this.closing = true; this.kick();
    }
    return this.drained.promise;
  }
  private rejectQueue({ error }: { error: unknown }): void {
    for (const entry of this.queue.splice(0)) {
      entry.settled.reject(error);
      if (!this.inFlight?.entries.includes(entry)) this.retainedBytes -= entry.bytes.buffer.byteLength;
    }
    this.drained.reject(error);
  }
  stop({ error }: { error: unknown }): Promise<void> {
    if (this.retirement) return this.retirement;
    this.stopped = true; this.failure ??= { error }; this.rejectQueue({ error: this.failure.error });
    return this.retireOwned({ mode: 'abort', error: this.failure.error });
  }
  /** Graceful retirement joins existing I/O without resetting a completed stream. */
  retire(): Promise<void> {
    return this.retireOwned({ mode: 'graceful', error: undefined });
  }
  private retireOwned({ mode, error }: { mode: 'abort' | 'graceful'; error: unknown }): Promise<void> {
    if (this.retirement) return this.retirement;
    const retired = deferred<void>(); this.retirement = retired.promise;
    void (async () => {
      const failures = new RetirementFailures({ onFailure: this.onRetirementFailure });
      const cleanup = (() => {
        switch (mode) {
        case 'abort': return [cancelReader({ reader: this.reader, reason: error }), abortWriter({ writer: this.writer, reason: error, ownedClose: this.closeWork })];
        case 'graceful': return [];
        default: { const unreachable: never = mode; throw new Error(String(unreachable)); }
        }
      })();
      // Read/decode and send failures are logical outcomes; still join their
      // continuations, but only explicit cleanup/release failure poisons retirement.
      await Promise.all(cleanup.map(work => failures.join({ work })));
      await Promise.allSettled([this.sendWork, ...this.reads]);
      try {
        this.release();
      } catch (error) {
        failures.add({ error });
      }
      failures.check();
    })().then(retired.resolve, retired.reject);
    return retired.promise;
  }
  release(): void {
    if (this.released) return;
    releaseLocks({ reader: this.reader, writer: this.writer });
    this.released = true; this.chunk = new Uint8Array();
  }
  private async bytes({ length, allowEnd }: { length: number; allowEnd: boolean }): Promise<Uint8Array | undefined> {
    const bytes = new ByteAssembly({ limit: length }); let written = 0;
    while (written < length) {
      if (this.cursor === this.chunk.length) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await this.reader.read();
        } catch (cause) {
          // Only the native read is wrapped; parser evidence uses its separate callback.
          throw new NaidanRpcError({ code: 'TRANSPORT_ERROR', cause });
        }
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
  read(): Promise<Frame | undefined> {
    if (this.retirement || this.released || this.failure) return Promise.reject(this.failure ? this.failure.error : new NaidanRpcError({ code: 'CANCELLED' }));
    const work = this.readFrame(); this.reads.add(work);
    void work.then(() => this.reads.delete(work), () => this.reads.delete(work));
    return work;
  }
  private rejectHeader({ result }: { result: Exclude<ProtocolHeaderResult, { kind: 'supported' }> }): never {
    if (this.stopped || this.failure) throw this.failure?.error;
    const error = new NaidanRpcProtocolError({ diagnostic: result }); this.failure = { error };
    this.rejectQueue({ error });
    try {
      this.onProtocolFailure({ error });
    } catch { /* Observation cannot replace local parser evidence. */ }
    throw error;
  }
  private checkReadActive(): void {
    if (this.stopped || this.failure) throw this.failure?.error;
  }
  private async readPreamble(): Promise<void> {
    const header = new ProtocolHeaderReader();
    for (;;) {
      this.checkReadActive();
      if (this.cursor === this.chunk.length) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await this.reader.read();
        } catch (cause) {
          // Only the native read is wrapped; parser evidence uses its separate callback.
          throw new NaidanRpcError({ code: 'TRANSPORT_ERROR', cause });
        }
        this.checkReadActive();
        if (next.done) {
          const result = header.finish();
          switch (result.kind) {
          case 'supported': return;
          case 'truncated-header': case 'wrong-protocol-magic': case 'invalid-protocol-version': case 'unsupported-protocol-version': return this.rejectHeader({ result });
          default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
          }
        }
        check({ condition: next.value instanceof Uint8Array && next.value.buffer instanceof ArrayBuffer && next.value.length > 0, code: 'PROTOCOL_ERROR' });
        this.chunk = next.value; this.cursor = 0;
      }
      const { consumedBytes, result } = header.push({ chunk: this.chunk.subarray(this.cursor) }); this.cursor += consumedBytes;
      switch (result.kind) {
      case 'need-more': break;
      case 'supported': return;
      case 'truncated-header': case 'wrong-protocol-magic': case 'invalid-protocol-version': case 'unsupported-protocol-version': return this.rejectHeader({ result });
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    }
  }
  private async readFrame(): Promise<Frame | undefined> {
    await (this.preambleRead ??= this.readPreamble());
    this.checkReadActive();
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
  writeOwnership: ({ framed }: { framed: FramedDuplex }) => ({
    retainedBytes: framed['retainedBytes'],
    scratchBytes: framed['inFlight']?.scratchBytes ?? 0,
    queue: framed['queue'].map(entry => ({ offset: entry.offset, backingBytes: entry.bytes.buffer.byteLength })),
    inFlightEntries: framed['inFlight']?.entries.length ?? 0,
  }),
};
