// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeProtocolHeader, inspectProtocolHeader, PROTOCOL_HEADER_BYTES, PROTOCOL_VERSION, ProtocolHeaderReader } from '@/features/naidan-rpc/protocol-header';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in header codec test'));
});

afterEach(() => vi.restoreAllMocks());

// Literal wire oracle, independent of the production encoder and DataView writes.
function vector({ versionBytes }: { versionBytes: readonly number[] }): Uint8Array {
  return Uint8Array.from([0, 110, 97, 105, 100, 97, 110, 114, 112, ...versionBytes]);
}

function inspect({ bytes }: { bytes: Uint8Array }) {
  return inspectProtocolHeader({ bytes });
}

it('encodes the exact 13-byte experimental-1 preamble and returns fresh owned bytes', () => {
  expect(PROTOCOL_HEADER_BYTES).toBe(13);
  expect(PROTOCOL_VERSION).toBe(2147483649);
  const expected = vector({ versionBytes: [1, 0, 0, 128] });
  const first = encodeProtocolHeader();
  expect(first).toEqual(expected);
  first.fill(255);
  expect(encodeProtocolHeader()).toEqual(expected);
  expect(inspect({ bytes: expected })).toEqual({ kind: 'supported', version: 2147483649 });
});

it.each(Array.from({ length: 13 }, (_, index) => index))('diagnoses definitive EOF at byte %i as truncated before magic/version', length => {
  const bytes = new Uint8Array(length).fill(255);
  expect(inspect({ bytes })).toEqual({ kind: 'truncated-header', availableBytes: length });
});

it.each(Array.from({ length: 9 }, (_, index) => index))('checks magic byte %i before inspecting the version', index => {
  const bytes = vector({ versionBytes: [0, 0, 0, 0] });
  bytes[index] = bytes[index]! ^ 255;
  expect(inspect({ bytes })).toEqual({ kind: 'wrong-protocol-magic' });
});

it('rejects the other protocol and never searches forward for a matching header', () => {
  const wrongProtocol = vector({ versionBytes: [1, 0, 0, 128] });
  wrongProtocol[7] = 112;
  wrongProtocol[8] = 100;
  expect(inspect({ bytes: wrongProtocol })).toEqual({ kind: 'wrong-protocol-magic' });
  const prefixed = new Uint8Array(14);
  prefixed.set(encodeProtocolHeader(), 1);
  expect(inspect({ bytes: prefixed })).toEqual({ kind: 'wrong-protocol-magic' });
});

it.each([
  { versionBytes: [0, 0, 0, 0], version: 0, kind: 'invalid-protocol-version' },
  { versionBytes: [0, 0, 0, 128], version: 2147483648, kind: 'invalid-protocol-version' },
  { versionBytes: [1, 0, 0, 0], version: 1, kind: 'unsupported-protocol-version' },
  { versionBytes: [2, 0, 0, 128], version: 2147483650, kind: 'unsupported-protocol-version' },
  { versionBytes: [128, 0, 0, 1], version: 16777344, kind: 'unsupported-protocol-version' },
  { versionBytes: [120, 86, 52, 146], version: 2452903544, kind: 'unsupported-protocol-version' },
  { versionBytes: [255, 255, 255, 127], version: 2147483647, kind: 'unsupported-protocol-version' },
  { versionBytes: [255, 255, 255, 255], version: 4294967295, kind: 'unsupported-protocol-version' },
])('keeps the complete unsigned u32LE version: $version', ({ versionBytes, version, kind }) => {
  expect(inspect({ bytes: vector({ versionBytes }) })).toEqual({ kind, version });
});

it.each([1, 2, 5, 9, 17])('honors view byteOffset %i and never reads beyond the view', offset => {
  const backing = new Uint8Array(offset + 13 + 9).fill(255);
  backing.set(vector({ versionBytes: [120, 86, 52, 146] }), offset);
  expect(inspect({ bytes: backing.subarray(offset, offset + 13) }))
    .toEqual({ kind: 'unsupported-protocol-version', version: 2452903544 });
  expect(inspect({ bytes: backing.subarray(offset, offset + 12) }))
    .toEqual({ kind: 'truncated-header', availableBytes: 12 });
  backing.set(encodeProtocolHeader(), offset);
  expect(inspect({ bytes: backing.subarray(offset, offset + 13) }))
    .toEqual({ kind: 'supported', version: 2147483649 });
});

it('rejects shared memory rather than racing a mutable concurrent header', () => {
  expect(() => inspect({ bytes: new Uint8Array(new SharedArrayBuffer(13)) })).toThrow(TypeError);
});

it('does not retain input, mutate it, or claim to validate payload bytes', () => {
  const bytes = new Uint8Array(32).fill(255);
  bytes.set(encodeProtocolHeader());
  const snapshot = bytes.slice();
  const result = inspect({ bytes });
  expect(bytes).toEqual(snapshot);
  bytes.fill(0);
  expect(result).toEqual({ kind: 'supported', version: 2147483649 });
});

it.each(Array.from({ length: 14 }, (_, index) => index))('accepts every two-chunk split at byte %i, including empty chunks', split => {
  const bytes = encodeProtocolHeader();
  const reader = new ProtocolHeaderReader();
  const first = reader.push({ chunk: bytes.subarray(0, split) });
  expect(first.consumedBytes).toBe(split);
  if (split < 13) {
    expect(first.result).toEqual({ kind: 'need-more', availableBytes: split });
    expect(reader.push({ chunk: new Uint8Array() }))
      .toEqual({ consumedBytes: 0, result: { kind: 'need-more', availableBytes: split } });
    expect(reader.push({ chunk: bytes.subarray(split) }))
      .toEqual({ consumedBytes: 13 - split, result: { kind: 'supported', version: 2147483649 } });
  } else {
    expect(first.result).toEqual({ kind: 'supported', version: 2147483649 });
  }
  expect(reader.finish()).toEqual({ kind: 'supported', version: 2147483649 });
});

it.each(Array.from({ length: 13 }, (_, index) => index))('only EOF diagnoses a partial %i-byte preamble as truncated', length => {
  const reader = new ProtocolHeaderReader();
  expect(reader.push({ chunk: encodeProtocolHeader().subarray(0, length) }).result)
    .toEqual({ kind: 'need-more', availableBytes: length });
  expect(reader.finish()).toEqual({ kind: 'truncated-header', availableBytes: length });
  expect(reader.finish()).toEqual({ kind: 'truncated-header', availableBytes: length });
  expect(() => reader.push({ chunk: encodeProtocolHeader() })).toThrow('already finished');
});

it('reports entirely missing adopted-stream header as truncated on EOF', () => {
  expect(new ProtocolHeaderReader().finish()).toEqual({ kind: 'truncated-header', availableBytes: 0 });
});

it('owns each one-byte fragment before the caller reuses its buffer', () => {
  const reader = new ProtocolHeaderReader();
  const bytes = encodeProtocolHeader();
  for (let index = 0; index < bytes.length; index++) {
    const chunk = bytes.slice(index, index + 1);
    const progress = reader.push({ chunk });
    expect(progress.consumedBytes).toBe(1);
    chunk.fill(255);
    if (index < 12) expect(progress.result).toEqual({ kind: 'need-more', availableBytes: index + 1 });
    else expect(progress.result).toEqual({ kind: 'supported', version: 2147483649 });
  }
  expect(reader.finish()).toEqual({ kind: 'supported', version: 2147483649 });
});

it('copies only the missing prefix of a large coalesced chunk and leaves payload with its caller', () => {
  const reader = new ProtocolHeaderReader();
  reader.push({ chunk: encodeProtocolHeader().subarray(0, 5) });
  const chunk = new Uint8Array(1024 * 1024).fill(255);
  chunk.set(encodeProtocolHeader().subarray(5));
  const set = vi.spyOn(Uint8Array.prototype, 'set');
  const progress = reader.push({ chunk });
  expect(progress).toEqual({ consumedBytes: 8, result: { kind: 'supported', version: 2147483649 } });
  expect(set).toHaveBeenCalledTimes(1);
  expect(set.mock.calls[0]![0].length).toBe(8);
  expect(chunk.subarray(progress.consumedBytes).length).toBe(1024 * 1024 - 8);
  expect(chunk[progress.consumedBytes]).toBe(255);
  chunk.fill(0);
  expect(reader.finish()).toEqual({ kind: 'supported', version: 2147483649 });
});

it.each([
  { bytes: new Uint8Array(13).fill(255), kind: 'wrong-protocol-magic' },
  { bytes: vector({ versionBytes: [0, 0, 0, 128] }), kind: 'invalid-protocol-version' },
  { bytes: vector({ versionBytes: [1, 0, 0, 0] }), kind: 'unsupported-protocol-version' },
  { bytes: encodeProtocolHeader(), kind: 'supported' },
])('makes $kind terminal without consuming a second preamble or any payload', ({ bytes, kind }) => {
  for (let split = 0; split < 13; split++) {
    const reader = new ProtocolHeaderReader();
    expect(reader.push({ chunk: bytes.subarray(0, split) }).result.kind).toBe('need-more');
    const chunk = new Uint8Array(26 - split);
    chunk.set(bytes.subarray(split));
    chunk.set(encodeProtocolHeader(), 13 - split);
    const progress = reader.push({ chunk });
    expect(progress.consumedBytes).toBe(13 - split);
    expect(progress.result.kind).toBe(kind);
    expect(reader.finish()).toEqual(progress.result);
    expect(Object.isFrozen(reader.finish())).toBe(true);
    expect(() => reader.push({ chunk: new Uint8Array() })).toThrow('already finished');
  }
});

it('rejects a shared fragment without committing it to reader state', () => {
  const reader = new ProtocolHeaderReader();
  expect(() => reader.push({ chunk: new Uint8Array(new SharedArrayBuffer(13)) })).toThrow(TypeError);
  expect(reader.push({ chunk: encodeProtocolHeader() }).result).toEqual({ kind: 'supported', version: 2147483649 });
});
