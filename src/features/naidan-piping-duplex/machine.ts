import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { MAX_OFFSET, SEGMENT_BYTES, RECEIVE_WINDOW, RETAINED_STREAMS, ownBytes, bitHas, bitSet, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { ByteQueue } from '@/features/naidan-piping-duplex/byte-queue';
import type { Snapshot, Segment } from '@/features/naidan-piping-duplex/wire';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
type Status = 'active' | 'finished' | 'reset';
type StreamRecord = {
    id: number;
    accepted: boolean;
    claimed: boolean;
    status: Status;
    txEnd: bigint;
    ack: bigint;
    peerLimit: bigint;
    offeredEnd: bigint;
    outgoing: {
        start: bigint;
        bytes: Uint8Array;
    } | undefined;
    pending: Segment | undefined;
    txFinal: bigint | undefined;
    peerSawFinal: boolean;
    rxNext: bigint;
    consumed: bigint;
    rxFinal: bigint | undefined;
    unread: ByteQueue;
};
function fresh({ id, accepted, claimed }: {
    id: number;
    accepted: boolean;
    claimed: boolean;
}): StreamRecord {
  return { id, accepted, claimed, status: 'active', txEnd: 0n, ack: 0n, peerLimit: 0n, offeredEnd: 0n,
    outgoing: undefined, pending: undefined, txFinal: undefined, peerSawFinal: false,
    rxNext: 0n, consumed: 0n, rxFinal: undefined, unread: ByteQueue.empty() };
}
function limit({ stream }: {
    stream: StreamRecord;
}): bigint {
  const next = stream.consumed + RECEIVE_WINDOW;
  return next > MAX_OFFSET ? MAX_OFFSET : next;
}
function cloneStream({ stream }: {
    stream: StreamRecord;
}): StreamRecord {
  // Buffers are immutable and private. Copy metadata, not every unconsumed byte.
  return { ...stream };
}
export class Machine {
  readonly role: NaidanPipingRole;
  private internalStreams = new Map<number, StreamRecord>();
  private internalFinished = new Uint8Array(8192);
  private internalReset = new Uint8Array(8192);
  private internalIncoming: number[] = [];
  private internalNextId: number;
  private internalCursor = 0;
  private internalGoaway = false;
  private internalPeerGoaway = false;
  constructor({ role }: {
        role: NaidanPipingRole;
    }) {
    this.role = role; this.internalNextId = isInitiator({ role: role }) ? 0 : 1;
  }
  private internalLocal({ id }: {
        id: number;
    }): boolean {
    return id % 2 === (isInitiator({ role: this.role }) ? 0 : 1);
  }
  private internalLookup({ id }: {
        id: number;
    }): StreamRecord {
    const stream = this.internalStreams.get(id);
    if (!stream)
      throw new Error('Stream not retained');
    return stream;
  }
  status({ id }: {
        id: number;
    }): Status {
    const stream = this.internalStreams.get(id);
    if (stream)
      return stream.status;
    if (bitHas({ bitmap: this.internalFinished, id }))
      return 'finished';
    if (bitHas({ bitmap: this.internalReset, id }))
      return 'reset';
    throw new Error('Unknown stream');
  }
  accepted({ id }: {
        id: number;
    }): boolean {
    return this.internalStreams.get(id)?.accepted ?? this.status({ id }) === 'finished';
  }
  retained(): number {
    return this.internalStreams.size;
  }
  incomingClosed(): boolean {
    return this.internalGoaway && this.internalIncoming.length === 0;
  }
  readEnded({ id }: {
        id: number;
    }): boolean {
    const stream = this.internalStreams.get(id);
    if (!stream)
      return this.status({ id }) === 'finished';
    return stream.rxFinal !== undefined && stream.rxNext === stream.rxFinal && stream.unread.length === 0;
  }
  hasActive(): boolean {
    return [...this.internalStreams.values()].some(stream => stream.status === 'active');
  }
  debug(): object {
    return { retained: this.internalStreams.size, incoming: this.internalIncoming.length, nextId: this.internalNextId,
      goaway: this.internalGoaway, peerGoaway: this.internalPeerGoaway,
      streams: [...this.internalStreams.values()].map(s => ({ id: s.id, status: s.status, accepted: s.accepted, claimed: s.claimed,
        peerLimit: String(s.peerLimit), offeredEnd: String(s.offeredEnd), unread: s.unread.length, pages: s.unread.pageCount, rxNext: String(s.rxNext),
        consumed: String(s.consumed), txEnd: String(s.txEnd), ack: String(s.ack),
        txFinal: s.txFinal?.toString(), rxFinal: s.rxFinal?.toString(), peerSawFinal: s.peerSawFinal })) };
  }
  open(): number {
    requireValue({ condition: !this.internalGoaway && !this.internalPeerGoaway, message: 'Session draining' });
    requireValue({ condition: this.internalStreams.size < RETAINED_STREAMS && this.internalNextId <= 65535, message: 'Stream capacity' });
    const id = this.internalNextId;
    this.internalNextId += 2;
    this.internalStreams.set(id, fresh({ id, accepted: false, claimed: true }));
    return id;
  }
  takeIncoming(): number | undefined {
    const id = this.internalIncoming.shift();
    if (id === undefined)
      return undefined;
    const stream = this.internalLookup({ id });
    stream.claimed = true;
    this.internalReclaim({ id });
    return id;
  }
  stopIncoming(): void {
    this.internalGoaway = true;
    for (const id of [...this.internalIncoming])
      this.resetStream({ id });
    this.internalIncoming = [];
  }
  drain(): void {
    this.internalGoaway = true;
  }
  checkWrite({ id, length }: {
        id: number;
        length: number;
    }): void {
    const stream = this.internalLookup({ id });
    requireValue({ condition: Number.isSafeInteger(length) && length >= 0, message: 'Write length' });
    requireValue({ condition: stream.status === 'active' && stream.accepted && stream.txFinal === undefined,
      message: 'Stream not writable' });
    requireValue({ condition: stream.outgoing === undefined, message: 'One write at a time' });
    requireValue({ condition: stream.txEnd + BigInt(length) <= MAX_OFFSET, message: 'Offset exhaustion' });
  }
  write({ id, bytes }: {
        id: number;
        bytes: Uint8Array;
    }): bigint {
    const copy = ownBytes({ bytes, maxBytes: 65536 });
    this.checkWrite({ id, length: copy.length });
    const stream = this.internalLookup({ id });
    if (copy.length !== 0) {
      stream.outgoing = { start: stream.txEnd, bytes: copy };
      stream.txEnd += BigInt(copy.length);
    }
    return stream.txEnd;
  }
  acknowledged({ id, end }: {
        id: number;
        end: bigint;
    }): boolean {
    return this.internalStreams.get(id)?.ack === end || this.status({ id }) === 'finished';
  }
  closeWrite({ id }: {
        id: number;
    }): void {
    const stream = this.internalLookup({ id });
    requireValue({ condition: stream.status === 'active' && stream.outgoing === undefined, message: 'Cannot close write' });
    stream.txFinal = stream.txEnd;
    this.internalSettle({ stream });
    this.internalReclaim({ id });
  }
  finalSeen({ id }: {
        id: number;
    }): boolean {
    return this.internalStreams.get(id)?.peerSawFinal === true || this.status({ id }) === 'finished';
  }
  read({ id }: {
        id: number;
    }): {
        kind: 'data';
        bytes: Uint8Array;
    } | {
        kind: 'end';
    } | {
        kind: 'wait';
    } {
    const stream = this.internalStreams.get(id);
    if (!stream) {
      requireValue({ condition: this.status({ id }) === 'finished', message: 'Stream reset' });
      return { kind: 'end' };
    }
    requireValue({ condition: stream.status !== 'reset', message: 'Stream reset' });
    const item = stream.unread.take();
    if (item) {
      stream.unread = item.remaining;
      stream.consumed += BigInt(item.bytes.length);
      this.internalReclaim({ id });
      return { kind: 'data', bytes: item.bytes };
    }
    if (stream.rxFinal !== undefined && stream.rxNext === stream.rxFinal) {
      this.internalReclaim({ id });
      return { kind: 'end' };
    }
    return { kind: 'wait' };
  }
  cancelRead({ id }: {
        id: number;
    }): void {
    const stream = this.internalStreams.get(id);
    if (stream && isFinished({ status: stream.status })) {
      stream.unread = ByteQueue.empty();
      stream.consumed = stream.rxNext;
      this.internalReclaim({ id });
    } else if (stream)
      this.resetStream({ id });
  }
  resetStream({ id }: {
        id: number;
    }): void {
    const stream = this.internalStreams.get(id);
    if (!stream || stream.status === 'finished')
      return;
    bitSet({ bitmap: this.internalReset, id });
    stream.status = 'reset';
    stream.unread = ByteQueue.empty();
    stream.outgoing = undefined;
    stream.pending = undefined;
    if (!stream.claimed) {
      stream.claimed = true;
      this.internalIncoming = this.internalIncoming.filter(value => value !== id);
    }
    this.internalReclaim({ id });
  }
  abort(): void {
    this.internalGoaway = true;
    for (const [id, stream] of this.internalStreams)
      if (!isFinished({ status: stream.status }))
        this.resetStream({ id });
  }
  private internalSettle({ stream }: {
        stream: StreamRecord;
    }): void {
    if (stream.status === 'active' && stream.txFinal !== undefined && stream.ack === stream.txFinal && stream.peerSawFinal &&
            stream.rxFinal !== undefined && stream.rxNext === stream.rxFinal) {
      stream.status = 'finished';
      bitSet({ bitmap: this.internalFinished, id: stream.id });
    }
  }
  private internalReclaim({ id }: {
        id: number;
    }): void {
    const stream = this.internalStreams.get(id);
    if (stream && stream.status !== 'active' && stream.claimed && stream.unread.length === 0)
      this.internalStreams.delete(id);
  }
  snapshot(): Snapshot {
    const states = [...this.internalStreams.values()].filter(s => s.status === 'active').map(s => ({ id: s.id,
      flags: (s.txFinal !== undefined ? 1 : 0) | (s.rxFinal !== undefined && s.rxNext === s.rxFinal ? 2 : 0),
      rxNext: s.rxNext, rxLimit: limit({ stream: s }), final: s.txFinal ?? 0n }));
    const active = [...this.internalStreams.values()].filter(s => s.status === 'active').sort((a, b) => a.id - b.id);
    const rotated = [...active.filter(s => s.id >= this.internalCursor), ...active.filter(s => s.id < this.internalCursor)];
    const data: Segment[] = [];
    for (const stream of rotated) {
      if (!stream.accepted)
        continue;
      if (!stream.pending && stream.outgoing && stream.ack < stream.txEnd && stream.ack < stream.peerLimit) {
        const size = Number([BigInt(SEGMENT_BYTES), stream.txEnd - stream.ack, stream.peerLimit - stream.ack].reduce((a, b) => a < b ? a : b));
        const start = Number(stream.ack - stream.outgoing.start);
        stream.pending = { id: stream.id, offset: stream.ack, bytes: stream.outgoing.bytes.slice(start, start + size) };
      }
      if (stream.pending) {
        data.push({ ...stream.pending, bytes: stream.pending.bytes.slice() });
        this.internalCursor = stream.id + 1;
      }
      if (data.length === 2)
        break;
    }
    return { goaway: this.internalGoaway, finished: this.internalFinished.slice(), reset: this.internalReset.slice(), states, data };
  }
  markOffered({ snapshot }: {
        snapshot: Snapshot;
    }): void {
    for (const segment of snapshot.data) {
      const stream = this.internalStreams.get(segment.id);
      if (stream?.status === 'active' && stream.pending?.offset === segment.offset)
        stream.offeredEnd = segment.offset + BigInt(segment.bytes.length);
    }
  }
  private internalDiffers({ other }: {
        other: Machine;
    }): boolean {
    if (this.internalPeerGoaway !== other.internalPeerGoaway || this.internalStreams.size !== other.internalStreams.size ||
            this.internalIncoming.length !== other.internalIncoming.length)
      return true;
    for (let index = 0; index < this.internalIncoming.length; index++)
      if (this.internalIncoming[index] !== other.internalIncoming[index])
        return true;
    for (let index = 0; index < this.internalFinished.length; index++)
      if (this.internalFinished[index] !== other.internalFinished[index] || this.internalReset[index] !== other.internalReset[index])
        return true;
    for (const [id, stream] of this.internalStreams) {
      const next = other.internalStreams.get(id);
      if (!next || stream.status !== next.status || stream.accepted !== next.accepted || stream.claimed !== next.claimed ||
                stream.peerLimit !== next.peerLimit || stream.ack !== next.ack || stream.peerSawFinal !== next.peerSawFinal ||
                stream.rxNext !== next.rxNext || stream.rxFinal !== next.rxFinal)
        return true;
    }
    return false;
  }
  accept({ snapshot }: {
        snapshot: Snapshot;
    }): boolean {
    // No asynchronous code or observable side effect before this transaction commits.
    const candidate = new Machine({ role: this.role });
    candidate.internalStreams = new Map([...this.internalStreams].map(([id, stream]) => [id, cloneStream({ stream })]));
    candidate.internalFinished = this.internalFinished.slice();
    candidate.internalReset = this.internalReset.slice();
    candidate.internalIncoming = [...this.internalIncoming];
    candidate.internalNextId = this.internalNextId;
    candidate.internalCursor = this.internalCursor;
    candidate.internalGoaway = this.internalGoaway;
    candidate.internalPeerGoaway = this.internalPeerGoaway;
    candidate.internalApply({ snapshot });
    const changed = this.internalDiffers({ other: candidate });
    this.internalStreams = candidate.internalStreams;
    this.internalFinished = candidate.internalFinished;
    this.internalReset = candidate.internalReset;
    this.internalIncoming = candidate.internalIncoming;
    this.internalPeerGoaway = candidate.internalPeerGoaway;
    return changed;
  }
  private internalApply({ snapshot }: {
        snapshot: Snapshot;
    }): void {
    requireValue({ condition: !this.internalPeerGoaway || snapshot.goaway, message: 'GOAWAY regression' });
    this.internalPeerGoaway = snapshot.goaway;
    for (let id = 0; id < snapshot.reset.length * 8; id++) {
      if (!bitHas({ bitmap: snapshot.reset, id }))
        continue;
      requireValue({ condition: !this.internalLocal({ id }) || id < this.internalNextId, message: 'Reset of unallocated local ID' });
      bitSet({ bitmap: this.internalReset, id });
      this.resetStream({ id });
    }
    // Existing terminal streams ignore delayed state and data, but cannot be resurrected.
    for (const state of snapshot.states) {
      const id = state.id;
      if (bitHas({ bitmap: this.internalReset, id }) || bitHas({ bitmap: this.internalFinished, id }))
        continue;
      let stream = this.internalStreams.get(id);
      if (!stream) {
        requireValue({ condition: !this.internalLocal({ id }), message: 'State for unallocated local ID' });
        requireValue({ condition: state.rxNext === 0n && (state.flags & 2) === 0,
          message: 'Unknown OPEN acknowledges data/final' });
        if (this.internalGoaway || this.internalStreams.size === RETAINED_STREAMS) {
          bitSet({ bitmap: this.internalReset, id });
          continue;
        }
        stream = fresh({ id, accepted: true, claimed: false });
        this.internalStreams.set(id, stream);
        this.internalIncoming.push(id);
      }
      requireValue({ condition: state.rxNext >= stream.ack && state.rxNext <= stream.offeredEnd &&
                    (state.rxNext === stream.ack || state.rxNext === stream.offeredEnd), message: 'Invalid acknowledgement' });
      requireValue({ condition: state.rxLimit >= stream.peerLimit && state.rxLimit - state.rxNext <= RECEIVE_WINDOW,
        message: 'Invalid receive credit' });
      if (stream.rxFinal !== undefined)
        requireValue({ condition: (state.flags & 1) !== 0 && state.final === stream.rxFinal,
          message: 'Final changed or withdrawn' });
      if ((state.flags & 1) !== 0) {
        requireValue({ condition: state.final >= stream.rxNext, message: 'Final below accepted data' });
        stream.rxFinal = state.final;
      }
      if (stream.peerSawFinal)
        requireValue({ condition: (state.flags & 2) !== 0, message: 'FIN_SEEN regression' });
      if ((state.flags & 2) !== 0) {
        requireValue({ condition: stream.txFinal !== undefined && state.rxNext === stream.txFinal, message: 'Premature FIN_SEEN' });
        stream.peerSawFinal = true;
      }
      stream.accepted = true;
      stream.ack = state.rxNext;
      stream.peerLimit = state.rxLimit;
      if (stream.pending && stream.ack === stream.pending.offset + BigInt(stream.pending.bytes.length))
        stream.pending = undefined;
      if (stream.outgoing && stream.ack === stream.txEnd)
        stream.outgoing = undefined;
    }
    for (const segment of snapshot.data) {
      const id = segment.id;
      if (bitHas({ bitmap: this.internalReset, id }) || bitHas({ bitmap: this.internalFinished, id }))
        continue;
      const stream = this.internalLookup({ id }), end = segment.offset + BigInt(segment.bytes.length);
      requireValue({ condition: snapshot.states.some(state => state.id === id), message: 'DATA without STATE' });
      if (end <= stream.rxNext)
        continue;
      requireValue({ condition: segment.offset >= stream.rxNext, message: 'Partial overlap' });
      if (segment.offset > stream.rxNext)
        continue;
      requireValue({ condition: end <= limit({ stream }) && (stream.rxFinal === undefined || end <= stream.rxFinal),
        message: 'DATA exceeds credit/final' });
      stream.unread = stream.unread.append({ bytes: segment.bytes });
      stream.rxNext = end;
    }
    for (let id = 0; id < snapshot.finished.length * 8; id++) {
      if (!bitHas({ bitmap: snapshot.finished, id }) || bitHas({ bitmap: this.internalReset, id }) || bitHas({ bitmap: this.internalFinished, id }))
        continue;
      const stream = this.internalLookup({ id });
      requireValue({ condition: stream.txFinal !== undefined && stream.rxFinal !== undefined && stream.rxNext === stream.rxFinal &&
                    stream.offeredEnd === stream.txFinal, message: 'Unproven FINISHED' });
      if (stream.txFinal === undefined)
        throw new Error('Missing local final');
      stream.ack = stream.txFinal;
      stream.peerSawFinal = true;
      stream.pending = undefined;
      stream.outgoing = undefined;
    }
    for (const [id, stream] of this.internalStreams) {
      this.internalSettle({ stream });
      this.internalReclaim({ id });
    }
  }
}



export function isFinished({ status }: { status: Status }): boolean {
  switch (status) {
  case 'finished': return true;
  case 'active': case 'reset': return false;
  default: { const unreachable: never = status; throw new Error(`Invalid stream state: ${unreachable}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
