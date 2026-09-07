import { describe, expect, it } from 'vitest';
import {
  decodeShellBytesToText,
  decodeShellUtf8Projection,
  decodeShellUtf8Text,
  encodeShellTextToBytes,
  findShellUtf8ByteOffsetForTextBoundary,
  shellByteValueToText,
} from './byte-text';

function formatBytes({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
}

function assertBytesEqual({
  actual,
  expected,
  context,
}: {
  actual: Uint8Array,
  expected: Uint8Array,
  context: string,
}): void {
  if (actual.length === expected.length) {
    let equal = true;
    for (let index = 0; index < actual.length; index += 1) {
      if (actual[index] !== expected[index]) {
        equal = false;
        break;
      }
    }
    if (equal) {
      return;
    }
  }

  throw new Error(
    `${context}: expected [${formatBytes({ bytes: expected })}], got [${formatBytes({ bytes: actual })}]`,
  );
}

function expectCompleteRoundTrip({ bytes }: { bytes: Uint8Array }): void {
  const projection = decodeShellUtf8Projection({
    bytes,
    completion: 'complete',
  });
  assertBytesEqual({
    actual: encodeShellTextToBytes({ text: projection.text }),
    expected: bytes,
    context: 'complete shell byte round-trip',
  });

  for (let characters = 0; characters < projection.textBoundaryByteOffsets.length; characters += 1) {
    const expectedByteOffset = projection.textBoundaryByteOffsets[characters];
    if (expectedByteOffset === undefined) {
      continue;
    }
    const actualByteOffset = findShellUtf8ByteOffsetForTextBoundary({
      bytes,
      completion: 'complete',
      characters,
    });
    if (actualByteOffset !== expectedByteOffset) {
      throw new Error(
        `shell text boundary ${characters} for [${formatBytes({ bytes })}]: `
        + `expected byte offset ${expectedByteOffset}, got ${actualByteOffset}`,
      );
    }
    assertBytesEqual({
      actual: encodeShellTextToBytes({
        text: projection.text.slice(0, characters),
      }),
      expected: bytes.subarray(0, expectedByteOffset),
      context: `shell text prefix ${characters} for [${formatBytes({ bytes })}]`,
    });
  }
}

describe('shell byte text', () => {
  it('round-trips every one-byte and two-byte sequence exactly', () => {
    for (let first = 0; first <= 0xff; first += 1) {
      expectCompleteRoundTrip({ bytes: Uint8Array.of(first) });
      for (let second = 0; second <= 0xff; second += 1) {
        expectCompleteRoundTrip({ bytes: Uint8Array.of(first, second) });
      }
    }
  });

  it('round-trips representative three-byte and four-byte boundary combinations exactly', () => {
    const continuationEdges = [
      0x00,
      0x7f,
      0x80,
      0x8f,
      0x90,
      0x9f,
      0xa0,
      0xbf,
      0xc0,
      0xff,
    ];

    for (const first of [0xe0, 0xe1, 0xed, 0xef]) {
      for (const second of continuationEdges) {
        for (const third of continuationEdges) {
          expectCompleteRoundTrip({ bytes: Uint8Array.of(first, second, third) });
        }
      }
    }
    for (const first of [0xf0, 0xf1, 0xf4]) {
      for (const second of continuationEdges) {
        for (const third of continuationEdges) {
          for (const fourth of continuationEdges) {
            expectCompleteRoundTrip({ bytes: Uint8Array.of(first, second, third, fourth) });
          }
        }
      }
    }
  });

  it('keeps a potentially valid incomplete UTF-8 sequence for a later source chunk', () => {
    const bytes = Uint8Array.of(0xf0, 0x9f, 0x98);
    expect(decodeShellUtf8Projection({
      bytes,
      completion: 'may-continue',
    })).toEqual({
      text: '',
      textBoundaryByteOffsets: [0],
      consumedBytes: 0,
    });
    expect(decodeShellUtf8Projection({
      bytes,
      completion: 'complete',
    })).toEqual({
      text: '\udcf0\udc9f\udc98',
      textBoundaryByteOffsets: [0, 1, 2, 3],
      consumedBytes: 3,
    });
  });

  it('decodes long valid runs around malformed bytes without consuming an incomplete tail', () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`${'a'.repeat(4096)}😀`);
    const suffix = encoder.encode(`β${'z'.repeat(4096)}`);
    const incompleteTail = Uint8Array.of(0xf0, 0x9f, 0x98);
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length + incompleteTail.length);
    bytes.set(prefix, 0);
    bytes[prefix.length] = 0xff;
    bytes.set(suffix, prefix.length + 1);
    bytes.set(incompleteTail, prefix.length + 1 + suffix.length);

    const consumedBytes = prefix.length + 1 + suffix.length;
    const expectedText = `${'a'.repeat(4096)}😀${String.fromCharCode(0xdcff)}β${'z'.repeat(4096)}`;

    expect(decodeShellUtf8Text({
      bytes,
      completion: 'may-continue',
    })).toEqual({
      text: expectedText,
      consumedBytes,
    });

    const projection = decodeShellUtf8Projection({
      bytes,
      completion: 'may-continue',
    });
    expect(projection.text).toBe(expectedText);
    expect(projection.consumedBytes).toBe(consumedBytes);
    expect(projection.textBoundaryByteOffsets.at(-1)).toBe(consumedBytes);
  });

  it('preserves malformed bytes independently while retaining valid Unicode', () => {
    expect(decodeShellUtf8Projection({
      bytes: Uint8Array.of(0xe2, 0x28, 0xa1),
      completion: 'complete',
    })).toEqual({
      text: '\udce2(\udca1',
      textBoundaryByteOffsets: [0, 1, 2, 3],
      consumedBytes: 3,
    });
    expect(decodeShellUtf8Projection({
      bytes: Uint8Array.of(0xe2, 0x82, 0x28),
      completion: 'complete',
    })).toEqual({
      text: '\udce2\udc82(',
      textBoundaryByteOffsets: [0, 1, 2, 3],
      consumedBytes: 3,
    });
    expect(decodeShellUtf8Projection({
      bytes: Uint8Array.of(0xf0, 0x9f, 0x98, 0x80),
      completion: 'complete',
    })).toEqual({
      text: '😀',
      textBoundaryByteOffsets: [0, undefined, 4],
      consumedBytes: 4,
    });
  });

  it('preserves UTF-8 BOM bytes instead of treating them as decoder metadata', () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    const text = decodeShellBytesToText({ bytes });
    expect(text).toBe('\ufeffa');
    expect([...encodeShellTextToBytes({ text })]).toEqual([...bytes]);
  });

  it('encodes raw-byte sentinels without changing valid surrogate pairs', () => {
    const text = `A😀${String.fromCharCode(0xdcff)}B`;
    expect([...encodeShellTextToBytes({ text })]).toEqual([
      0x41,
      0xf0, 0x9f, 0x98, 0x80,
      0xff,
      0x42,
    ]);
    expect(decodeShellBytesToText({
      bytes: Uint8Array.of(0x41, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0x42),
    })).toBe(text);
  });

  it('encodes long adjacent raw-byte sentinel runs without changing surrounding Unicode', () => {
    const rawBytes = Uint8Array.from({ length: 512 }, (_value, index) => 0x80 + (index % 0x80));
    const rawText = Array.from(rawBytes, (byte) => shellByteValueToText({ byte })).join('');
    const text = `prefix😀${rawText}suffix`;
    const expectedPrefix = new TextEncoder().encode('prefix😀');
    const expectedSuffix = new TextEncoder().encode('suffix');
    const expected = new Uint8Array(expectedPrefix.length + rawBytes.length + expectedSuffix.length);
    expected.set(expectedPrefix, 0);
    expected.set(rawBytes, expectedPrefix.length);
    expected.set(expectedSuffix, expectedPrefix.length + rawBytes.length);

    assertBytesEqual({
      actual: encodeShellTextToBytes({ text }),
      expected,
      context: 'long raw-byte sentinel run',
    });
  });

  it('represents single shell byte values without changing their byte identity', () => {
    expect(shellByteValueToText({ byte: 0x41 })).toBe('A');
    expect(shellByteValueToText({ byte: 0x80 })).toBe('\udc80');
    expect([...encodeShellTextToBytes({ text: shellByteValueToText({ byte: 0xff }) })]).toEqual([0xff]);
  });
});
