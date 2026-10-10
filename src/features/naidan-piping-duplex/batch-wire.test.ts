// @vitest-environment node
import { expect, it } from 'vitest';
import { batchHeader, decodeFrames, encodeFrame, inspectBatchHeader, DATA_BYTES, validateReceiveLimits } from '@/features/naidan-piping-duplex/batch-wire';
import type { Frame } from '@/features/naidan-piping-duplex/batch-wire';
import { MAX_OFFSET, joinBytes } from '@/features/naidan-piping-duplex/bytes';

const token = new Uint8Array(32).fill(19);
const frames: Frame[] = [
  { kind: 'ready', limits: { streams: 32, connectionWindow: 4194304, streamWindow: 1114112 } },
  { kind: 'open', id: 0 }, { kind: 'accept', id: 0xffffffff }, { kind: 'fin', id: 3 },
  { kind: 'reset', id: 4, reason: 'cancelled' }, { kind: 'reset', id: 4, reason: 'capacity' }, { kind: 'reset', id: 4, reason: 'draining' },
  { kind: 'data', id: 5, bytes: new Uint8Array(DATA_BYTES).fill(37) },
  { kind: 'window-stream', id: 6, released: MAX_OFFSET }, { kind: 'window-connection', released: 0n },
  { kind: 'ping', token }, { kind: 'pong', token }, { kind: 'close', token }, { kind: 'close-ack', token },
];

it.each(frames)('round trips the $kind frame', frame => {
  expect(decodeFrames({ bytes: encodeFrame({ frame }) })).toEqual([frame]);
});

it('decodes concatenated frames and rejects every truncated prefix of one frame', () => {
  const small = frames.filter(frame => frame.kind !== 'data');
  expect(decodeFrames({ bytes: joinBytes({ parts: small.map(frame => encodeFrame({ frame })) }) })).toEqual(small);
  for (const frame of frames.filter(frame => frame.kind !== 'data')) {
    const bytes = encodeFrame({ frame });
    for (let size = 0; size < bytes.length; size++) expect(() => decodeFrames({ bytes: bytes.subarray(0, size) })).toThrow();
  }
});

it('rejects the removed kinds, invalid reasons, forged lengths and empty DATA', () => {
  for (const kind of [6, 9, 255]) {
    const bytes = encodeFrame({ frame: { kind: 'open', id: 0 } }); bytes[0] = kind;
    expect(() => decodeFrames({ bytes })).toThrow();
  }
  const reset = encodeFrame({ frame: { kind: 'reset', id: 0, reason: 'cancelled' } }); reset[9] = 3;
  expect(() => decodeFrames({ bytes: reset })).toThrow();
  const close = encodeFrame({ frame: { kind: 'close', token } }); close[5] = 1;
  expect(() => decodeFrames({ bytes: close })).toThrow();
  const empty = encodeFrame({ frame: { kind: 'open', id: 0 } }); empty[0] = 3;
  expect(() => decodeFrames({ bytes: empty })).toThrow();
  new DataView(empty.buffer).setUint32(1, 0xffffffff);
  expect(() => decodeFrames({ bytes: empty })).toThrow();
  expect(() => encodeFrame({ frame: { kind: 'data', id: 0, bytes: new Uint8Array(DATA_BYTES + 1) } })).toThrow();
});

it('checks per-record frame count and positive bounded windows', () => {
  const bytes = encodeFrame({ frame: { kind: 'fin', id: 0 } });
  expect(decodeFrames({ bytes: joinBytes({ parts: Array(256).fill(bytes) }) })).toHaveLength(256);
  expect(() => decodeFrames({ bytes: joinBytes({ parts: Array(257).fill(bytes) }) })).toThrow();
  for (const field of ['streams', 'connectionWindow', 'streamWindow'] as const) {
    for (const value of [0, -1, 0.5, Infinity, NaN, 0xffffffff]) {
      expect(() => validateReceiveLimits({ limits: { streams: 32, connectionWindow: 4194304, streamWindow: 1114112, [field]: value } })).toThrow();
    }
  }
});

it('validates the whole fixed batch header without accepting unknown versions', () => {
  for (const count of [1, 2, 256]) expect(inspectBatchHeader({ header: batchHeader({ count }) })).toBe(count);
  for (const count of [0, 257, -1, 1.5]) expect(() => batchHeader({ count })).toThrow();
  const header = batchHeader({ count: 1 });
  for (const offset of [0, 8, 9, 13]) {
    const bad = header.slice(); bad[offset]! ^= 1;
    expect(() => inspectBatchHeader({ header: bad })).toThrow();
  }
});
