import { snapshotSchema } from '@/features/naidan-piping-duplex/schemas';
import { RECORD_PLAINTEXT_BYTES, MAX_OFFSET, SEGMENT_BYTES, ownBytes, requireValue } from '@/features/naidan-piping-duplex/bytes';
export type StreamState = {
    id: number;
    flags: number;
    rxNext: bigint;
    rxLimit: bigint;
    final: bigint;
};
export type Segment = {
    id: number;
    offset: bigint;
    bytes: Uint8Array;
};
export type Snapshot = {
    goaway: boolean;
    finished: Uint8Array;
    reset: Uint8Array;
    states: StreamState[];
    data: Segment[];
};
export type RecordPayload = {
    receiptRequest: 'requested' | 'not-requested';
    receivedRecord: bigint | undefined;
    snapshot: Snapshot;
    challenge: Uint8Array | undefined;
    echo: Uint8Array | undefined;
};
export function receiptRequested({ request }: { request: RecordPayload['receiptRequest'] }): boolean {
  switch (request) {
  case 'requested': return true;
  case 'not-requested': return false;
  default: { const unreachable: never = request; throw new Error(`Invalid receipt request: ${unreachable}`); }
  }
}
const HEADER_BYTES = 5, STATE_BYTES = 27, DATA_HEADER_BYTES = 12;
function unsigned({ value, max }: {
    value: number;
    max: number;
}): void {
  requireValue({ condition: Number.isInteger(value) && value >= 0 && value <= max, message: 'Unsigned field range' });
}
/** A closed, bounded snapshot schema. Payload metadata has its own strict codec. */
export function encodeSnapshot({ snapshot }: {
    snapshot: Snapshot;
}): Uint8Array {
  const { goaway, finished, reset, states, data, ...rest } = snapshot;
    rest satisfies Record<PropertyKey, never>;
    requireValue({ condition: typeof goaway === 'boolean' && states.length <= 32 && data.length <= 2, message: 'Snapshot shape/count' });
    const f = ownBytes({ bytes: finished, maxBytes: 8192 }), r = ownBytes({ bytes: reset, maxBytes: 8192 });
    let size = Math.max(f.length, r.length);
    while (size > 0 && !(f[size - 1] || r[size - 1]))
      size--;
    const ordered = [...states].sort((a, b) => a.id - b.id);
    const segments = [...data].sort((a, b) => a.id - b.id).map(segment => {
      const { id, offset, bytes, ...rest } = segment;
        rest satisfies Record<PropertyKey, never>;
        return { id, offset, bytes: ownBytes({ bytes, maxBytes: SEGMENT_BYTES }) };
    });
    let total = HEADER_BYTES + size * 2 + ordered.length * STATE_BYTES;
    for (const segment of segments)
      total += DATA_HEADER_BYTES + segment.bytes.length;
    requireValue({ condition: total <= RECORD_PLAINTEXT_BYTES, message: 'Snapshot size' });
    const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
    bytes[0] = goaway ? 1 : 0;
    view.setUint16(1, size, false);
    bytes[3] = ordered.length;
    bytes[4] = segments.length;
    bytes.set(f.subarray(0, size), HEADER_BYTES);
    bytes.set(r.subarray(0, size), HEADER_BYTES + size);
    let at = HEADER_BYTES + 2 * size;
    for (const state of ordered) {
      const { id, flags, rxNext, rxLimit, final, ...rest } = state;
        rest satisfies Record<PropertyKey, never>;
        unsigned({ value: id, max: 65535 });
        unsigned({ value: flags, max: 3 });
        requireValue({
          condition: rxNext >= 0n && rxNext <= rxLimit && rxLimit <= MAX_OFFSET && final >= 0n && final <= MAX_OFFSET,
          message: 'Unsigned offset range',
        });
        view.setUint16(at, id, false);
        bytes[at + 2] = flags;
        view.setBigUint64(at + 3, rxNext, false);
        view.setBigUint64(at + 11, rxLimit, false);
        view.setBigUint64(at + 19, final, false);
        at += STATE_BYTES;
    }
    for (const { id, offset, bytes: body } of segments) {
      unsigned({ value: id, max: 65535 });
      requireValue({ condition: offset >= 0n && offset + BigInt(body.length) <= MAX_OFFSET, message: 'Unsigned offset range' });
      view.setUint16(at, id, false);
      view.setBigUint64(at + 2, offset, false);
      view.setUint16(at + 10, body.length, false);
      bytes.set(body, at + DATA_HEADER_BYTES);
      at += DATA_HEADER_BYTES + body.length;
    }
    // One canonical decoder also guards outbound duplicates and unused fields.
    decodeSnapshot({ bytes });
    return bytes;
}
export function decodeSnapshot({ bytes }: {
    bytes: Uint8Array;
}): Snapshot {
  const owned = ownBytes({ bytes, maxBytes: RECORD_PLAINTEXT_BYTES });
  requireValue({ condition: owned.length >= HEADER_BYTES, message: 'Snapshot header' });
  const view = new DataView(owned.buffer), size = view.getUint16(1, false), stateCount = owned[3]!, dataCount = owned[4]!;
  requireValue({
    condition: (owned[0] === 0 || owned[0] === 1) && size <= 8192 && stateCount <= 32 && dataCount <= 2,
    message: 'Snapshot flags/count',
  });
  let at = HEADER_BYTES + size * 2;
  requireValue({
    condition: at + stateCount * STATE_BYTES + dataCount * (DATA_HEADER_BYTES + 1) <= owned.length,
    message: 'Truncated snapshot',
  });
  const finished = owned.slice(HEADER_BYTES, HEADER_BYTES + size), reset = owned.slice(HEADER_BYTES + size, at);
  requireValue({ condition: size === 0 || !!(finished[size - 1] || reset[size - 1]), message: 'Noncanonical bitmap' });
  const states: StreamState[] = [], data: Segment[] = [];
  let lastId = -1;
  for (let index = 0; index < stateCount; index++) {
    const id = view.getUint16(at, false), flags = owned[at + 2]!;
    const rxNext = view.getBigUint64(at + 3, false), rxLimit = view.getBigUint64(at + 11, false), final = view.getBigUint64(at + 19, false);
    requireValue({ condition: id > lastId && flags <= 3, message: 'State order/flags' });
    requireValue({
      condition: rxNext <= rxLimit && rxLimit <= MAX_OFFSET && final <= MAX_OFFSET && ((flags & 1) !== 0 || final === 0n),
      message: 'State offset/unused final',
    });
    states.push({ id, flags, rxNext, rxLimit, final });
    lastId = id;
    at += STATE_BYTES;
  }
  lastId = -1;
  for (let index = 0; index < dataCount; index++) {
    requireValue({ condition: at + DATA_HEADER_BYTES <= owned.length, message: 'Truncated DATA header' });
    const id = view.getUint16(at, false), offset = view.getBigUint64(at + 2, false), length = view.getUint16(at + 10, false);
    at += DATA_HEADER_BYTES;
    requireValue({
      condition: id > lastId && length >= 1 && length <= SEGMENT_BYTES && at + length <= owned.length &&
                offset + BigInt(length) <= MAX_OFFSET,
      message: 'DATA size/order/offset',
    });
    data.push({ id, offset, bytes: owned.slice(at, at + length) });
    lastId = id;
    at += length;
  }
  requireValue({ condition: at === owned.length, message: 'Trailing bytes' });
  return snapshotSchema.parse({ goaway: owned[0] === 1, finished, reset, states, data });
}

/** Receipt metadata shares the existing record authentication and size budget. */
export function encodeRecordPayload({ payload }: { payload: RecordPayload }): Uint8Array {
  const { receiptRequest, receivedRecord, snapshot, challenge, echo, ...rest } = payload;
  rest satisfies Record<PropertyKey, never>;
  requireValue({ condition: receivedRecord === undefined || (receivedRecord >= 0n && receivedRecord <= MAX_OFFSET), message: 'Receipt number range' });
  for (const token of [challenge, echo]) requireValue({ condition: token === undefined || (token instanceof Uint8Array && token.buffer instanceof ArrayBuffer && token.byteLength === 32), message: 'Response token length' });
  const body = encodeSnapshot({ snapshot });
  const headerBytes = 1 + (receivedRecord === undefined ? 0 : 8) + (challenge === undefined ? 0 : 32) + (echo === undefined ? 0 : 32);
  requireValue({ condition: headerBytes + body.length <= RECORD_PLAINTEXT_BYTES, message: 'Record payload size' });
  const bytes = new Uint8Array(headerBytes + body.length);
  bytes[0] = (receiptRequested({ request: receiptRequest }) ? 1 : 0) | (receivedRecord === undefined ? 0 : 2) | (challenge === undefined ? 0 : 4) | (echo === undefined ? 0 : 8);
  if (receivedRecord !== undefined) new DataView(bytes.buffer).setBigUint64(1, receivedRecord, false);
  let cursor = receivedRecord === undefined ? 1 : 9;
  for (const token of [challenge, echo]) if (token !== undefined) {
    bytes.set(token, cursor); cursor += 32;
  }
  bytes.set(body, headerBytes);
  return bytes;
}

export function decodeRecordPayload({ bytes }: { bytes: Uint8Array }): RecordPayload {
  const owned = ownBytes({ bytes, maxBytes: RECORD_PLAINTEXT_BYTES });
  requireValue({ condition: owned.length >= 1 && (owned[0]! & ~15) === 0, message: 'Receipt flags' });
  const hasReceipt = (owned[0]! & 2) !== 0, hasChallenge = (owned[0]! & 4) !== 0, hasEcho = (owned[0]! & 8) !== 0;
  const headerBytes = 1 + (hasReceipt ? 8 : 0) + (hasChallenge ? 32 : 0) + (hasEcho ? 32 : 0);
  requireValue({ condition: owned.length >= headerBytes + HEADER_BYTES, message: 'Truncated receipt' });
  const receivedRecord = !hasReceipt ? undefined : new DataView(owned.buffer).getBigUint64(1, false);
  requireValue({ condition: receivedRecord === undefined || receivedRecord <= MAX_OFFSET, message: 'Receipt number range' });
  let cursor = hasReceipt ? 9 : 1;
  const challenge = hasChallenge ? owned.slice(cursor, cursor + 32) : undefined; if (hasChallenge) cursor += 32;
  const echo = hasEcho ? owned.slice(cursor, cursor + 32) : undefined;
  return {
    challenge,
    echo,
    receiptRequest: (owned[0]! & 1) === 0 ? 'not-requested' : 'requested',
    receivedRecord,
    snapshot: decodeSnapshot({ bytes: owned.subarray(headerBytes) }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
