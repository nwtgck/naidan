// @vitest-environment node
import { expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot } from '@/features/naidan-piping-duplex/wire';
import type { Snapshot, StreamState } from '@/features/naidan-piping-duplex/wire';
import { CAPSULE_BYTES, MAX_OFFSET } from '@/features/naidan-piping-duplex/bytes';
import { emptySnapshot, pattern, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

function state({ id }: { id: number }): StreamState {
  return { id, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n };
}
function hex({ value, width }: { value: number | bigint; width: number }): string {
  return BigInt(value).toString(16).padStart(width * 2, '0');
}
/** Independent oracle: hex concatenation, not production DataView or a codec round-trip. */
function reference({ snapshot }: { snapshot: Snapshot }): Uint8Array {
  const { goaway, finished, reset, states, data, ...unhandled } = snapshot;
  unhandled satisfies Record<PropertyKey, never>;
  let size = Math.max(finished.length, reset.length);
  while (size && !(finished[size - 1] || reset[size - 1])) size--;
  let text = hex({ value: goaway ? 1 : 0, width: 1 }) + hex({ value: size, width: 2 }) +
    hex({ value: states.length, width: 1 }) + hex({ value: data.length, width: 1 });
  for (const bitmap of [finished, reset])
    for (let at = 0; at < size; at++) text += hex({ value: bitmap[at] ?? 0, width: 1 });
  for (const item of [...states].sort((a, b) => a.id - b.id)) {
    const { id, flags, rxNext, rxLimit, final, ...unhandledState } = item;
    unhandledState satisfies Record<PropertyKey, never>;
    text += hex({ value: id, width: 2 }) + hex({ value: flags, width: 1 }) +
      hex({ value: rxNext, width: 8 }) + hex({ value: rxLimit, width: 8 }) + hex({ value: final, width: 8 });
  }
  for (const item of [...data].sort((a, b) => a.id - b.id)) {
    const { id, offset, bytes, ...unhandledSegment } = item;
    unhandledSegment satisfies Record<PropertyKey, never>;
    text += hex({ value: id, width: 2 }) + hex({ value: offset, width: 8 }) +
      hex({ value: bytes.length, width: 2 }) + Buffer.from(bytes).toString('hex');
  }
  return new Uint8Array(Buffer.from(text, 'hex'));
}

it('empty state is exactly five bytes, not a self-consistent encoder/decoder invention', () => {
  expect(encodeSnapshot({ snapshot: emptySnapshot() })).toEqual(new Uint8Array(5));
  expect(decodeSnapshot({ bytes: new Uint8Array(5) })).toEqual(emptySnapshot());
  expect(() => decodeSnapshot({ bytes: new Uint8Array(6) })).toThrow('Trailing');
});

it('independent wire oracle agrees across 512 deterministic fragmented shapes', () => {
  let random = 0x19273845;
  const next = () => {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0;
  };
  for (let trial = 0; trial < 512; trial++) {
    const states = Array.from({ length: next() % 33 }, (_, id) => {
      const flags = next() % 4;
      return { id: id * 2, flags, rxNext: BigInt(next()), rxLimit: 1n << 40n, final: flags & 1 ? 1n << 42n : 0n };
    });
    const snapshot: Snapshot = {
      ...emptySnapshot(),
      goaway: !!(next() & 1),
      states: [...states].reverse(),
      finished: new Uint8Array([next() & 255]),
      reset: new Uint8Array([next() & 255]),
      data: states.slice(0, next() % 3).reverse().map(item => ({
        id: item.id,
        offset: item.rxNext,
        bytes: pattern({ size: 1 + next() % 64, seed: next() }),
      })),
    };
    const encoded = encodeSnapshot({ snapshot });
    expect(encoded, `seeded shape ${trial}`).toEqual(reference({ snapshot }));
    expect(encodeSnapshot({ snapshot: decodeSnapshot({ bytes: encoded }) })).toEqual(encoded);
  }
});

it('the maximum legal snapshot fits its independently calculated size', () => {
  const bitmap = new Uint8Array(8192); bitmap[8191] = 128;
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    finished: bitmap,
    reset: bitmap,
    states: Array.from({ length: 32 }, (_, id) => state({ id })),
    data: [0, 1].map(id => ({ id, offset: 0n, bytes: new Uint8Array(16384) })),
  };
  const encoded = encodeSnapshot({ snapshot });
  expect(encoded.length).toBe(50045);
  expect(encoded.length).toBeLessThan(CAPSULE_BYTES - 25);
  expect(encoded).toEqual(reference({ snapshot }));
  expect(() => encodeSnapshot({ snapshot: { ...snapshot, states: [...snapshot.states, state({ id: 32 })] } })).toThrow('count');
  expect(() => encodeSnapshot({ snapshot: { ...snapshot, data: [...snapshot.data, { id: 2, offset: 0n, bytes: new Uint8Array([1]) }] } })).toThrow('count');
});

it('every truncated prefix and an appended suffix of a mixed snapshot are rejected', () => {
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    finished: new Uint8Array([1]),
    states: [state({ id: 0 }), state({ id: 1 })],
    data: [{ id: 0, offset: 0n, bytes: new Uint8Array(71) }, { id: 1, offset: 0n, bytes: new Uint8Array(27) }],
  };
  const bytes = encodeSnapshot({ snapshot });
  for (let end = 0; end < bytes.length; end++) expect(() => decodeSnapshot({ bytes: bytes.subarray(0, end) }), `prefix ${end}`).toThrow();
  const appended = new Uint8Array(bytes.length + 1); appended.set(bytes);
  expect(() => decodeSnapshot({ bytes: appended })).toThrow('Trailing');
});

it('all 256 state flag values are checked and unused final offsets must be zero', () => {
  const bytes = encodeSnapshot({ snapshot: { ...emptySnapshot(), states: [state({ id: 0 })] } });
  for (let flags = 0; flags < 256; flags++) {
    const changed = bytes.slice(); changed[7] = flags;
    if (flags < 4) expect(decodeSnapshot({ bytes: changed }).states[0]?.flags).toBe(flags);
    else expect(() => decodeSnapshot({ bytes: changed })).toThrow('flags');
  }
  bytes[bytes.length - 1] = 1;
  expect(() => decodeSnapshot({ bytes })).toThrow('final');
});

it.each([-1, 65536, 1.5, NaN, Infinity])('stream identifier %s is rejected instead of narrowed', id => {
  expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), states: [state({ id })] } })).toThrow('range');
  expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), data: [{ id, offset: 0n, bytes: new Uint8Array([1]) }] } })).toThrow('range');
});

it('offset boundaries are exact and overflow never wraps', () => {
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    states: [{ id: 65535, flags: 1, rxNext: MAX_OFFSET, rxLimit: MAX_OFFSET, final: MAX_OFFSET }],
    data: [{ id: 65535, offset: MAX_OFFSET - 1n, bytes: new Uint8Array([1]) }],
  };
  expect(decodeSnapshot({ bytes: encodeSnapshot({ snapshot }) })).toEqual(snapshot);
  for (const offset of [-1n, MAX_OFFSET, MAX_OFFSET + 1n, 1n << 64n]) {
    expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), data: [{ id: 0, offset, bytes: new Uint8Array([1]) }] } })).toThrow('range');
  }
  for (const rxNext of [-1n, MAX_OFFSET + 1n]) {
    expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), states: [{ ...state({ id: 0 }), rxNext }] } })).toThrow('range');
  }
});

it('duplicate state and DATA identifiers and noncanonical terminal padding have no alternate spelling', () => {
  expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), states: [state({ id: 0 }), state({ id: 0 })] } })).toThrow('order');
  const segment = { id: 0, offset: 0n, bytes: new Uint8Array([1]) };
  expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), data: [segment, segment] } })).toThrow('order');
  expect(() => decodeSnapshot({ bytes: new Uint8Array([0, 0, 1, 0, 0, 0, 0]) })).toThrow('Noncanonical');
  expect(() => encodeSnapshot({ snapshot: { ...emptySnapshot(), data: [{ ...segment, bytes: new Uint8Array() }] } })).toThrow();
});

it('decoded DATA and bitmaps own their buffers and do not expose another segment', () => {
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    finished: new Uint8Array([8]),
    reset: new Uint8Array([16]),
    data: [{ id: 0, offset: 0n, bytes: new Uint8Array([1, 2]) }, { id: 1, offset: 0n, bytes: new Uint8Array([3, 4, 5]) }],
  };
  const bytes = encodeSnapshot({ snapshot }), decoded = decodeSnapshot({ bytes });
  bytes.fill(0); new Uint8Array(decoded.data[0]!.bytes.buffer).fill(9); decoded.finished.fill(0);
  expect(decoded.data[1]!.bytes).toEqual(new Uint8Array([3, 4, 5]));
  expect(decoded.reset).toEqual(new Uint8Array([16]));
  expect(decoded.data[0]!.bytes.buffer.byteLength).toBe(2);
  expect(snapshot.data[0]!.bytes).toEqual(new Uint8Array([1, 2]));
});

it('oversized, shared and malformed headers are rejected before returning state', () => {
  for (const bytes of [new Uint8Array(CAPSULE_BYTES - 24), new Uint8Array(new SharedArrayBuffer(5)),
    new Uint8Array([2, 0, 0, 0, 0]), new Uint8Array([0, 255, 255, 0, 0]),
    new Uint8Array([0, 0, 0, 33, 0]), new Uint8Array([0, 0, 0, 0, 3])]) {
    expect(() => decodeSnapshot({ bytes })).toThrow();
  }
});
