import { expect, it } from 'vitest';
import { createWaitAccounting, uploadByteLength, uploadBucket } from './performance-counters';
it.each([
  { data: new Uint8Array(24), dataOffset: 4, size: 8, bytes: 8 },
  { data: new Float32Array(8), dataOffset: 2, size: 3, bytes: 12 },
  { data: new Uint16Array(new ArrayBuffer(64), 8, 12), dataOffset: 2, bytes: 20 },
  { data: new DataView(new ArrayBuffer(64), 4, 20), dataOffset: 4, size: 8, bytes: 8 },
  { data: new ArrayBuffer(32), dataOffset: 4, bytes: 28 },
  { data: new SharedArrayBuffer(32), size: 12, bytes: 12 },
  { data: new Float32Array(8), dataOffset: 9, bytes: undefined },
  { data: new Uint8Array(8), dataOffset: 4, size: 8, bytes: undefined },
  { data: new Uint8Array(8), size: 0, bytes: 0 },
])('counts writeBuffer bytes, not element count, for $data', ({ bytes, ...input }) => {
  expect(uploadByteLength(input)).toBe(bytes);
});
it('does not read payloads or mutate native data', () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  expect(uploadByteLength({ data })).toBe(4); expect([...data]).toEqual([1, 2, 3, 4]);
  expect(uploadBucket({ bytes: 256 })).toBe(0); expect(uploadBucket({ bytes: 257 })).toBe(1);
  expect(uploadBucket({ bytes: 1e9 })).toBe(7);
});
it('distinguishes overlapping wall sum from union, including still-pending waits', () => {
  let time = 0;
  const meter = createWaitAccounting({ now: () => time });
  const first = meter.start(); time = 10; const second = meter.start(); time = 30;
  expect(meter.snapshot()).toMatchObject({ started: 2, settled: 0, pending: 2, peakPending: 2, wallSumMs: 50, wallUnionMs: 30 });
  first({ failed: false }); time = 50;
  expect(meter.snapshot()).toMatchObject({ pending: 1, wallSumMs: 70, wallUnionMs: 50 });
  second({ failed: true }); second({ failed: false }); time = 100;
  expect(meter.snapshot()).toEqual({ started: 2, settled: 2, rejected: 1, pending: 0, peakPending: 2, wallSumMs: 70, wallUnionMs: 50, maxCompletedMs: 40 });
});
it('adds disjoint unions without counting idle gaps as wait time', () => {
  let time = 5; const meter = createWaitAccounting({ now: () => time });
  const first = meter.start(); time = 15; first({ failed: false });
  time = 50; const second = meter.start(); time = 80; second({ failed: false });
  expect(meter.snapshot()).toMatchObject({ wallSumMs: 40, wallUnionMs: 40, peakPending: 1 });
});
