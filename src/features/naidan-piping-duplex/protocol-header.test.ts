// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeProtocolHeader, inspectProtocolHeader, PROTOCOL_HEADER_BYTES, PROTOCOL_VERSION } from '@/features/naidan-piping-duplex/protocol-header';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in header codec test'));
});

afterEach(() => vi.restoreAllMocks());

// Literal wire oracle, independent of the production encoder and DataView writes.
function vector({ versionBytes }: { versionBytes: readonly number[] }): Uint8Array {
  return Uint8Array.from([0, 110, 97, 105, 100, 97, 110, 112, 100, ...versionBytes]);
}
function inspect({ bytes }: { bytes: Uint8Array }) {
  return inspectProtocolHeader({ bytes, maxBytes: 65536 });
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
  wrongProtocol[7] = 114;
  wrongProtocol[8] = 112;
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
  { versionBytes: [3, 0, 0, 128], version: 2147483651, kind: 'unsupported-protocol-version' },
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

it.each([13, 304, 336, 8368, 65536])('checks finite body cap %i before header diagnostics', maxBytes => {
  const exact = new Uint8Array(maxBytes);
  exact.set(encodeProtocolHeader());
  expect(inspectProtocolHeader({ bytes: exact, maxBytes })).toEqual({ kind: 'supported', version: 2147483649 });
  const oversized = new Uint8Array(maxBytes + 1).fill(255);
  expect(inspectProtocolHeader({ bytes: oversized, maxBytes })).toEqual({ kind: 'oversized-message' });
});

it.each([-1, 0, 12, 13.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid caller body cap %s', maxBytes => {
  expect(() => inspectProtocolHeader({ bytes: encodeProtocolHeader(), maxBytes })).toThrow(RangeError);
});

it('inspects a finite header without copying or exposing any of the containing body', () => {
  const bytes = new Uint8Array(65536);
  bytes.set(encodeProtocolHeader());
  const slice = vi.spyOn(bytes, 'slice');
  const subarray = vi.spyOn(bytes, 'subarray');
  expect(inspectProtocolHeader({ bytes, maxBytes: 65536 })).toEqual({ kind: 'supported', version: 2147483649 });
  expect(slice).not.toHaveBeenCalled();
  expect(subarray).not.toHaveBeenCalled();
});
