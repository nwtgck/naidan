import { describe, expect, it } from 'vitest';
import { decodeBase64UrlUnpadded, encodeBase64UrlUnpadded } from '@/00-storage/service/hizofs/00-format/v1/encoding/base64-url';
import { decodeLowercaseHex, encodeLowercaseHex } from '@/00-storage/service/hizofs/00-format/v1/encoding/lowercase-hex';
import { decodeFilenameComponent, decodeUtf8Strict, encodeFilenameComponent, encodedFilenameComponentByteLength, encodedSymlinkTargetByteLength, encodePassphraseUtf8, encodeSymlinkTarget, encodeUtf8Strict, compareFilenameComponentsByUtf8, writeFilenameComponent } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
import { compareUnsignedBytes } from '@/00-storage/service/hizofs/00-format/v1/ordering/unsigned-bytes';
import { createTimestampMilliseconds, createUInt64, TIMESTAMP_MILLISECONDS_MAXIMUM, TIMESTAMP_MILLISECONDS_MINIMUM, UINT64_MAXIMUM } from '@/00-storage/service/hizofs/00-format/v1/scalars';

describe('HizoFS V1 primitive contracts', () => {
  it('keeps exact UTF-8 bytes without normalization', () => {
    expect([...encodeUtf8Strict({ value: 'é' })]).toEqual([0xc3, 0xa9]);
    expect([...encodeUtf8Strict({ value: 'e\u0301' })]).toEqual([0x65, 0xcc, 0x81]);
    expect(() => encodeUtf8Strict({ value: '\ud800' })).toThrow('unpaired high surrogate');
    expect(() => decodeUtf8Strict({ bytes: Uint8Array.of(0xc0, 0x80) })).toThrow('well-formed UTF-8');
  });

  it('enforces filename, symlink, and passphrase byte profiles', () => {
    const maximum = 'a'.repeat(255);
    expect(decodeFilenameComponent({ bytes: encodeFilenameComponent({ value: maximum }) })).toBe(maximum);
    expect(() => encodeFilenameComponent({ value: 'a'.repeat(256) })).toThrow('1..255');
    for (const invalid of ['', '.', '..', 'a/b', 'a\0b']) expect(() => encodeFilenameComponent({ value: invalid })).toThrow();
    for (const invalid of ['.', '..', 'a/b', 'a\0b']) {
      expect(() => decodeFilenameComponent({ bytes: encodeUtf8Strict({ value: invalid }) })).toThrow();
    }
    expect(() => decodeFilenameComponent({ bytes: new Uint8Array(0) })).toThrow('1..255');
    expect(() => decodeFilenameComponent({ bytes: encodeUtf8Strict({ value: 'a'.repeat(256) }) })).toThrow('1..255');
    expect(() => decodeFilenameComponent({ bytes: Uint8Array.of(0xc0, 0x80) })).toThrow('well-formed UTF-8');
    expect(() => decodeFilenameComponent({ bytes: Uint8Array.of(0xed, 0xa0, 0x80) })).toThrow('well-formed UTF-8');
    expect([...encodeSymlinkTarget({ value: '../a/b' })]).toEqual([...encodeUtf8Strict({ value: '../a/b' })]);
    expect(() => encodePassphraseUtf8({ value: `\
line
feed` })).toThrow('line separator');
    expect([...encodePassphraseUtf8({ value: '  passphrase  ' })]).toEqual([...encodeUtf8Strict({ value: '  passphrase  ' })]);
  });

  it('measures filename and symlink UTF-8 bytes without materializing encoded payloads', () => {
    for (const value of ['a', 'é', 'e\u0301', '日本語', '😀', 'a😀β']) {
      expect(encodedFilenameComponentByteLength({ value })).toBe(encodeFilenameComponent({ value }).byteLength);
    }
    for (const value of ['target', '../a/b', '日本語/😀']) {
      expect(encodedSymlinkTargetByteLength({ value })).toBe(encodeSymlinkTarget({ value }).byteLength);
    }
    expect(encodedFilenameComponentByteLength({ value: 'a'.repeat(255) })).toBe(255);
    expect(() => encodedFilenameComponentByteLength({ value: 'a'.repeat(256) })).toThrow('1..255');
    expect(() => encodedFilenameComponentByteLength({ value: '\ud800' })).toThrow('unpaired high surrogate');
    expect(() => encodedSymlinkTargetByteLength({ value: 'a\0b' })).toThrow('NUL');
  });

  it('compares filename components exactly as canonical unsigned UTF-8 bytes', () => {
    const pairs = [
      ['a', 'aa'],
      ['\u007f', '\u0080'],
      ['\u07ff', '\u0800'],
      ['\ud7ff', '\ue000'],
      ['\uffff', '𐀀'],
      ['😀', '😁'],
      ['日本', '日本語'],
      ['é', 'e\u0301'],
    ] as const;
    for (const [left, right] of pairs) {
      const expected = Math.sign(compareUnsignedBytes({
        left: encodeFilenameComponent({ value: left }),
        right: encodeFilenameComponent({ value: right }),
      }));
      expect(Math.sign(compareFilenameComponentsByUtf8({ left, right }))).toBe(expected);
      expect(Math.sign(compareFilenameComponentsByUtf8({ left: right, right: left }))).toBe(-expected);
    }
    expect(compareFilenameComponentsByUtf8({ left: 'same', right: 'same' })).toBe(0);
  });

  it('writes filename UTF-8 directly into a bounded destination without changing canonical bytes', () => {
    for (const value of ['a', 'é', 'e\u0301', '日本語', '😀', 'a😀β']) {
      const expected = encodeFilenameComponent({ value });
      const destination = new Uint8Array(expected.byteLength + 4).fill(0xa5);
      const written = writeFilenameComponent({ bytes: destination, offset: 2, value });
      expect(written).toBe(expected.byteLength);
      expect([...destination.subarray(2, 2 + written)]).toEqual([...expected]);
      expect(destination[0]).toBe(0xa5);
      expect(destination[1]).toBe(0xa5);
      expect(destination.at(-2)).toBe(0xa5);
      expect(destination.at(-1)).toBe(0xa5);
    }
    expect(() => writeFilenameComponent({ bytes: new Uint8Array(1), offset: 1, value: 'a' })).toThrow('destination');
    expect(() => writeFilenameComponent({ bytes: new Uint8Array(8), offset: 0, value: '\ud800' })).toThrow('unpaired high surrogate');
  });

  it('uses canonical lowercase hex and unpadded Base64URL', () => {
    const bytes = Uint8Array.of(0, 15, 16, 255);
    expect(encodeLowercaseHex({ bytes })).toBe('000f10ff');
    expect([...decodeLowercaseHex({ expectedBytes: 4, value: '000f10ff' })]).toEqual([...bytes]);
    expect(() => decodeLowercaseHex({ value: '000F10ff' })).toThrow('lowercase');
    expect(encodeBase64UrlUnpadded({ bytes: Uint8Array.of(0xfb, 0xff) })).toBe('-_8');
    expect([...decodeBase64UrlUnpadded({ maximumDecodedBytes: 2, value: '-_8' })]).toEqual([0xfb, 0xff]);
    expect(() => decodeBase64UrlUnpadded({ maximumDecodedBytes: 2, value: '-_8=' })).toThrow('canonical');
    expect(() => decodeBase64UrlUnpadded({ maximumDecodedBytes: 8, value: 'A' })).toThrow('canonical');
    expect(() => decodeBase64UrlUnpadded({ maximumDecodedBytes: 2, value: 'AAAA' })).toThrow('exceeds');
  });

  it('orders byte strings as unsigned bytes without locale rules', () => {
    expect(compareUnsignedBytes({ left: Uint8Array.of(0x7f), right: Uint8Array.of(0x80) })).toBe(-1);
    expect(compareUnsignedBytes({ left: Uint8Array.of(1), right: Uint8Array.of(1, 0) })).toBe(-1);
    expect(compareUnsignedBytes({ left: Uint8Array.of(255), right: Uint8Array.of(255) })).toBe(0);
  });

  it('bounds UInt64 and persisted timestamp values as bigint', () => {
    expect(createUInt64({ value: UINT64_MAXIMUM })).toBe(UINT64_MAXIMUM);
    expect(() => createUInt64({ value: -1n })).toThrow('UInt64');
    expect(() => createUInt64({ value: UINT64_MAXIMUM + 1n })).toThrow('UInt64');
    expect(createTimestampMilliseconds({ value: TIMESTAMP_MILLISECONDS_MINIMUM })).toBe(TIMESTAMP_MILLISECONDS_MINIMUM);
    expect(createTimestampMilliseconds({ value: TIMESTAMP_MILLISECONDS_MAXIMUM })).toBe(TIMESTAMP_MILLISECONDS_MAXIMUM);
    expect(() => createTimestampMilliseconds({ value: TIMESTAMP_MILLISECONDS_MAXIMUM + 1n })).toThrow('timestamp');
  });
});
