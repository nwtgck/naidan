import { MAX_OFFSET, Pulse, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { OwnedByteQueue } from '@/features/naidan-piping-duplex/owned-byte-queue';
import {
  BATCH_BYTES, BATCH_HEADER_BYTES, CONTROL_LIMIT, DATA_BYTES, FRAMES_PER_RECORD, MAX_STREAM_ID,
  PLAINTEXT_BYTES, RECORDS_PER_BATCH, encodeFrame, validateReceiveLimits,
} from '@/features/naidan-piping-duplex/batch-wire';
import type { Frame, ReceiveLimits, ResetReason } from '@/features/naidan-piping-duplex/batch-wire';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
import { isInitiator } from '@/features/naidan-piping-duplex/role';

function deferred<Value>() {
  const result = Promise.withResolvers<Value>(); void result.promise.catch(() => {}); return result;
}
export type MultiplexedStream = {
  readonly id: number; readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>; abort({ reason }: { reason: string }): void;
};
type Write = { bytes: Uint8Array; offset: number; result: ReturnType<typeof deferred<void>> };
type StreamState = {
  id: number; local: boolean; facade: MultiplexedStream; input: OwnedByteQueue;
  pulse: Pulse; opening: ReturnType<typeof deferred<MultiplexedStream>>; completion: ReturnType<typeof deferred<void>>;
  controller: WritableStreamDefaultController | undefined; write: Write | undefined;
  finish: ReturnType<typeof deferred<void>> | undefined;
  openNeeded: boolean; openSealed: boolean; acceptNeeded: boolean; accepted: boolean;
  finSealed: boolean; finSent: boolean; remoteFin: boolean; readCancelled: boolean;
  reset: Error | undefined; resetNeeded: boolean; inFlight: number;
  sent: bigint; peerReleased: bigint; received: bigint; released: bigint; advertised: bigint;
};
type Flow = { sent: bigint; peerReleased: bigint; received: bigint; released: bigint; advertised: bigint };
export type TransmissionResult = { kind: 'sent' } | { kind: 'failed'; error: unknown };
export type Transmission = { plaintexts: Uint8Array[]; complete({ result }: { result: TransmissionResult }): void };

/** Packing neither waits for future bytes nor changes the semantic order of selected frames. */
class BatchBuilder {
  private readonly records: { parts: Uint8Array[]; size: number }[] = [];
  private wireBytes = BATCH_HEADER_BYTES;
  get dataCapacity(): number {
    return Math.max(0, Math.min(DATA_BYTES, BATCH_BYTES - this.wireBytes - 29));
  }
  add({ frame }: { frame: Frame }): boolean {
    const bytes = encodeFrame({ frame }); let last = this.records[this.records.length - 1];
    const newRecord = !last || last.parts.length === FRAMES_PER_RECORD || last.size + bytes.length > PLAINTEXT_BYTES;
    if (this.wireBytes + bytes.length + (newRecord ? 20 : 0) > BATCH_BYTES || (newRecord && this.records.length === RECORDS_PER_BATCH)) return false;
    if (newRecord) {
      last = { parts: [], size: 0 }; this.records.push(last); this.wireBytes += 20;
    }
    last!.parts.push(bytes); last!.size += bytes.length; this.wireBytes += bytes.length; return true;
  }
  finish(): Uint8Array[] {
    return this.records.map(record => {
      const bytes = new Uint8Array(record.size); let offset = 0;
      for (const part of record.parts) {
        bytes.set(part, offset); offset += part.length;
      }
      return bytes;
    });
  }
}

/** Single synchronous state owner: no speculative clone, snapshot replay, or per-stream tombstones. */
export class StreamMux {
  private readonly streams = new Map<number, StreamState>();
  private readonly incoming: number[] = [];
  private readonly refusals: { id: number; reason: ResetReason }[] = [];
  private readonly flow: Flow = { sent: 0n, peerReleased: 0n, received: 0n, released: 0n, advertised: 0n };
  private nextId: number;
  private highestLocal = -1;
  private highestRemote = -1;
  private cursor = -1;
  private readonly parity: number;
  private peer: ReceiveLimits | undefined;
  private publicReady = false;
  private draining = false;
  private stopped: Error | undefined;
  private iteratorClaimed = false;
  private nextPending = false;
  private readonly local: ReceiveLimits;
  readonly changed = new Pulse();
  constructor({ role, limits }: { role: NaidanPipingRole; limits: ReceiveLimits }) {
    this.local = validateReceiveLimits({ limits }); this.parity = isInitiator({ role }) ? 0 : 1; this.nextId = this.parity;
  }
  get limits(): ReceiveLimits {
    return { ...this.local };
  }
  setPeerLimits({ limits }: { limits: ReceiveLimits }): void {
    requireValue({ condition: !this.peer, message: 'Duplicate READY' }); this.peer = validateReceiveLimits({ limits });
  }
  activate(): void {
    requireValue({ condition: !!this.peer && !this.stopped, message: 'Mux not ready' }); this.publicReady = true; this.changed.fire();
  }
  private alive(): void {
    if (this.stopped) throw this.stopped;
  }
  private allowed(): void {
    this.alive(); requireValue({ condition: this.publicReady && !this.draining, message: 'Connection not accepting streams' });
  }
  private checkControls(): void {
    const pending = this.refusals.length + [...this.streams.values()].reduce((n, s) => n + Number(s.openNeeded) + Number(s.acceptNeeded) + Number(s.resetNeeded) + Number(!!s.finish && !s.finSealed) + Number(s.released !== s.advertised && !s.reset), 0);
    requireValue({ condition: pending <= CONTROL_LIMIT, message: 'Control descriptor limit exceeded' });
  }
  private add({ current, amount }: { current: bigint; amount: bigint }): bigint {
    requireValue({ condition: amount >= 0n && current + amount <= MAX_OFFSET, message: 'Flow counter exhausted' }); return current + amount;
  }
  private release({ state, count }: { state: StreamState; count: number }): void {
    const amount = BigInt(count); state.released = this.add({ current: state.released, amount });
    this.flow.released = this.add({ current: this.flow.released, amount });
    requireValue({ condition: state.released <= state.received && this.flow.released <= this.flow.received, message: 'Double receive release' });
    this.changed.fire();
  }
  private collect({ state }: { state: StreamState }): void {
    if (state.inFlight || state.resetNeeded) return;
    if (!state.reset && !(state.finSent && state.remoteFin && state.input.byteLength === 0)) return;
    this.streams.delete(state.id);
    const index = this.incoming.indexOf(state.id); if (index >= 0) this.incoming.splice(index, 1);
    state.completion.resolve(); state.pulse.fire(); this.changed.fire();
  }
  private reset({ state, error, notify }: { state: StreamState; error: Error; notify: boolean }): void {
    if (state.reset) return;
    state.reset = error;
    state.opening.reject(error); state.write?.result.reject(error); state.write = undefined; state.finish?.reject(error);
    state.controller?.error(error);
    this.release({ state, count: state.input.clear() });
    state.openNeeded = false; state.acceptNeeded = false;
    state.resetNeeded = notify && state.openSealed && !this.stopped;
    state.pulse.fire(); this.changed.fire(); this.collect({ state }); this.checkControls();
  }
  private create({ id, local }: { id: number; local: boolean }): StreamState {
    const opening = deferred<MultiplexedStream>(), completion = deferred<void>(), pulse = new Pulse();
    // The closures run after state initialization (the start hook only records its controller).
    let controller: WritableStreamDefaultController | undefined;
    const state: StreamState = {
      id,
      local,
      opening,
      completion,
      pulse,
      input: new OwnedByteQueue({ capacity: this.local.streamWindow }),
      controller: undefined,
      write: undefined,
      finish: undefined,
      openNeeded: local,
      openSealed: !local,
      acceptNeeded: !local,
      accepted: false,
      finSealed: false,
      finSent: false,
      remoteFin: false,
      readCancelled: false,
      reset: undefined,
      resetNeeded: false,
      inFlight: 0,
      sent: 0n,
      peerReleased: 0n,
      received: 0n,
      released: 0n,
      advertised: 0n,
      facade: {
        id,
        closed: completion.promise,
        readable: new ReadableStream<Uint8Array>({
          pull: async output => {
            for (;;) {
              if (state.readCancelled) return;
              if (state.reset) throw state.reset;
              if (state.remoteFin && !state.input.byteLength) {
                output.close(); this.collect({ state }); return;
              }
              this.alive();
              if (state.input.byteLength) {
                const bytes = state.input.take({ maximum: 65_536 }); this.release({ state, count: bytes.length });
                output.enqueue(bytes); this.collect({ state }); return;
              }
              if (state.remoteFin) {
                output.close(); this.collect({ state }); return;
              }
              await state.pulse.wait({ revision: state.pulse.revision, signal: undefined });
            }
          },
          cancel: () => {
            state.readCancelled = true; this.reset({ state, error: new Error('Stream read cancelled'), notify: true });
          },
        }, { highWaterMark: 0 }),
        writable: new WritableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          write: bytes => {
            this.alive(); if (state.reset) throw state.reset;
            requireValue({ condition: bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer && !state.write && !state.finish, message: 'Invalid stream write' });
            if (!bytes.length) return;
            const result = deferred<void>(); state.write = { bytes, offset: 0, result }; this.changed.fire(); return result.promise;
          },
          close: () => {
            this.alive(); if (state.reset) throw state.reset;
            requireValue({ condition: !state.write && !state.finish, message: 'FIN before preceding write completed' });
            state.finish = deferred<void>(); this.changed.fire(); return state.finish.promise;
          },
          abort: () => {
            this.reset({ state, error: new Error('Stream write aborted'), notify: true }); return completion.promise;
          },
        }, { highWaterMark: 1 }),
        abort: ({ reason }) => this.reset({ state, error: new Error(reason), notify: true }),
      },
    };
    state.controller = controller; this.streams.set(id, state); return state;
  }
  async openStream({ signal }: { signal: AbortSignal | undefined }): Promise<MultiplexedStream> {
    signal?.throwIfAborted(); this.allowed();
    requireValue({ condition: this.streams.size < Math.min(this.local.streams, this.peer!.streams) && this.nextId <= MAX_STREAM_ID, message: 'Stream capacity exhausted' });
    const id = this.nextId; this.nextId += 2;
    const state = this.create({ id, local: true });
    const abort = () => this.reset({ state, error: new Error('Stream open cancelled', { cause: signal?.reason }), notify: true });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.changed.fire();
    try {
      return await state.opening.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  readonly incomingStreams: AsyncIterable<MultiplexedStream> = {
    [Symbol.asyncIterator]: () => {
      requireValue({ condition: !this.iteratorClaimed, message: 'Incoming streams already owned' }); this.iteratorClaimed = true;
      let returned = false;
      return {
        next: async (): Promise<IteratorResult<MultiplexedStream>> => {
          requireValue({ condition: !this.nextPending, message: 'Concurrent incoming next' }); this.nextPending = true;
          try {
            for (;;) {
              if (returned || this.stopped) return { done: true, value: undefined };
              const id = this.incoming.shift();
              if (id !== undefined) {
                const state = this.streams.get(id); if (state && !state.reset) return { done: false, value: state.facade };
                continue;
              }
              await this.changed.wait({ revision: this.changed.revision, signal: undefined });
            }
          } finally {
            this.nextPending = false;
          }
        },
        return: async (): Promise<IteratorResult<MultiplexedStream>> => {
          returned = true; this.draining = true; this.changed.fire(); return { done: true, value: undefined };
        },
      };
    },
  };
  private past({ id }: { id: number }): void {
    const high = id % 2 === this.parity ? this.highestLocal : this.highestRemote;
    requireValue({ condition: id <= high, message: 'Frame references an unpublished stream' });
  }
  accept({ frame }: { frame: Frame }): void {
    requireValue({ condition: !!this.peer, message: 'Application frame before READY' });
    switch (frame.kind) {
    case 'open': {
      requireValue({ condition: frame.id % 2 !== this.parity && frame.id > this.highestRemote, message: 'Invalid or reused OPEN' });
      this.highestRemote = frame.id;
      if (this.stopped || this.draining || this.streams.size >= this.local.streams) {
        requireValue({ condition: this.refusals.length < CONTROL_LIMIT, message: 'Refusal queue exhausted' });
        this.refusals.push({ id: frame.id, reason: this.draining || this.stopped ? 'draining' : 'capacity' });
      } else this.create({ id: frame.id, local: false });
      this.checkControls(); this.changed.fire(); return;
    }
    case 'window-connection':
      requireValue({ condition: frame.released >= this.flow.peerReleased && frame.released <= this.flow.sent, message: 'Invalid connection credit' });
      this.flow.peerReleased = frame.released; this.changed.fire(); return;
    case 'data': {
      this.past({ id: frame.id }); const state = this.streams.get(frame.id), amount = BigInt(frame.bytes.length);
      this.flow.received = this.add({ current: this.flow.received, amount });
      requireValue({ condition: this.flow.received - this.flow.advertised <= BigInt(this.local.connectionWindow), message: 'Connection receive window exceeded' });
      if (!state || state.reset || this.stopped) {
        this.flow.released = this.add({ current: this.flow.released, amount }); this.changed.fire(); return;
      }
      requireValue({ condition: state.accepted && !state.remoteFin, message: 'DATA before ACCEPT or after FIN' });
      state.received = this.add({ current: state.received, amount });
      requireValue({ condition: state.received - state.advertised <= BigInt(this.local.streamWindow), message: 'Stream receive window exceeded' });
      state.input.append({ bytes: frame.bytes }); state.pulse.fire(); return;
    }
    case 'accept': case 'fin': case 'reset': case 'window-stream': {
      this.past({ id: frame.id }); const state = this.streams.get(frame.id);
      if (!state || state.reset) return;
      switch (frame.kind) {
      case 'accept':
        requireValue({ condition: state.local && state.openSealed && !state.accepted, message: 'Unexpected ACCEPT' });
        state.accepted = true; state.opening.resolve(state.facade); break;
      case 'fin':
        requireValue({ condition: state.accepted && !state.remoteFin, message: 'Unexpected FIN' });
        state.remoteFin = true; state.pulse.fire(); this.collect({ state }); break;
      case 'reset': this.reset({ state, error: new Error(`Peer reset stream: ${frame.reason}`), notify: false }); break;
      case 'window-stream':
        requireValue({ condition: state.accepted && frame.released >= state.peerReleased && frame.released <= state.sent, message: 'Invalid stream credit' });
        state.peerReleased = frame.released; break;
      default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
      }
      this.changed.fire(); return;
    }
    default: throw new Error('Unexpected mux control');
    }
  }
  /** All state changes below precede encryption/fetch. On failure the whole session ends, never rolls back. */
  prepare({ controls = [] }: { controls?: readonly Frame[] }): Transmission | undefined {
    const builder = new BatchBuilder(), retained = new Set<StreamState>(), finishes = new Set<StreamState>();
    const retain = ({ state }: { state: StreamState }) => {
      if (!retained.has(state)) {
        retained.add(state); state.inFlight++;
      }
    };
    for (const frame of controls) requireValue({ condition: builder.add({ frame }), message: 'Control batch exceeds bound' });
    if (!this.stopped && this.publicReady) {
      while (this.refusals.length) {
        const first = this.refusals[0]!;
        if (!builder.add({ frame: { kind: 'reset', ...first } })) break;
        this.refusals.shift();
      }
      if (this.flow.released !== this.flow.advertised && builder.add({ frame: { kind: 'window-connection', released: this.flow.released } })) this.flow.advertised = this.flow.released;
      const states = [...this.streams.values()].sort((left, right) => left.id - right.id);
      // OPEN identifiers are monotonic on the wire. Data fairness must never rotate them.
      for (const state of states) {
        if (!state.openNeeded || state.reset) continue;
        if (!builder.add({ frame: { kind: 'open', id: state.id } })) break;
        retain({ state }); state.openNeeded = false; state.openSealed = true; this.highestLocal = state.id;
      }
      // A bounded rotating order prevents a large write from monopolizing every batch.
      const split = states.findIndex(state => state.id > this.cursor);
      const ordered = split < 0 ? states : [...states.slice(split), ...states.slice(0, split)];
      for (const state of ordered) {
        if (state.resetNeeded && builder.add({ frame: { kind: 'reset', id: state.id, reason: 'cancelled' } })) {
          retain({ state }); state.resetNeeded = false;
        }
        if (state.reset) continue;
        if (state.acceptNeeded && builder.add({ frame: { kind: 'accept', id: state.id } })) {
          retain({ state }); state.acceptNeeded = false; state.accepted = true; this.incoming.push(state.id); this.changed.fire();
        }
        if (state.released !== state.advertised && builder.add({ frame: { kind: 'window-stream', id: state.id, released: state.released } })) {
          retain({ state }); state.advertised = state.released;
        }
        if (state.finish && !state.finSealed && !state.write && state.accepted && builder.add({ frame: { kind: 'fin', id: state.id } })) {
          retain({ state }); finishes.add(state); state.finSealed = true;
        }
      }
      let progress = true;
      while (progress && builder.dataCapacity > 0) {
        progress = false;
        for (const state of ordered) {
          const write = state.write;
          if (state.reset || !state.accepted || !write || write.offset === write.bytes.length) continue;
          const available = Math.min(Number(BigInt(this.peer!.streamWindow) + state.peerReleased - state.sent), Number(BigInt(this.peer!.connectionWindow) + this.flow.peerReleased - this.flow.sent));
          const count = Math.min(available, write.bytes.length - write.offset, builder.dataCapacity);
          if (count <= 0) continue;
          if (!builder.add({ frame: { kind: 'data', id: state.id, bytes: write.bytes.subarray(write.offset, write.offset + count) } })) continue;
          retain({ state });
          state.sent = this.add({ current: state.sent, amount: BigInt(count) }); this.flow.sent = this.add({ current: this.flow.sent, amount: BigInt(count) });
          write.offset += count; this.cursor = state.id; progress = true;
        }
      }
    }
    const plaintexts = builder.finish(); if (!plaintexts.length) return undefined;
    let completed = false;
    return {
      plaintexts,
      complete: ({ result }) => {
        if (completed) return; completed = true;
        switch (result.kind) {
        case 'sent': break;
        case 'failed': this.stop({ error: result.error }); break;
        default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
        }
        for (const state of retained) {
          state.inFlight--;
          if (!state.reset && !this.stopped) {
            if (state.write && state.write.offset === state.write.bytes.length) {
              state.write.result.resolve(); state.write = undefined;
            }
            if (finishes.has(state)) {
              state.finSent = true; state.finish?.resolve();
            }
          }
          this.collect({ state });
        }
        for (const bytes of plaintexts) bytes.fill(0);
        this.changed.fire();
      },
    };
  }
  stop({ error }: { error: unknown }): void {
    if (this.stopped) return;
    this.stopped = error instanceof Error ? error : new Error('Connection ended', { cause: error }); this.draining = true;
    this.refusals.length = 0;
    for (const state of [...this.streams.values()]) {
      state.resetNeeded = false;
      this.reset({ state, error: this.stopped, notify: false }); this.collect({ state });
    }
    this.changed.fire();
  }
  async drain({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    this.draining = true;
    while (this.streams.size) {
      this.alive(); await this.changed.wait({ revision: this.changed.revision, signal });
    }
  }
  debug(): object {
    return { retained: this.streams.size, refusals: this.refusals.length, ...this.flow };
  }
}

export const TEST_ONLY = {
};
