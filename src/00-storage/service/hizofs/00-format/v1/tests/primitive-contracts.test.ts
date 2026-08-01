import { describe, expect, it } from 'vitest';
import { decodeBase64UrlUnpadded, encodeBase64UrlUnpadded } from '@/00-storage/service/hizofs/00-format/v1/encoding/base64-url';
import { decodeLowercaseHex, encodeLowercaseHex } from '@/00-storage/service/hizofs/00-format/v1/encoding/lowercase-hex';
import { decodeFilenameComponent, decodeUtf8Strict, encodeFilenameComponent, encodePassphraseUtf8, encodeSymlinkTarget, encodeUtf8Strict } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
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
    expect([...encodeSymlinkTarget({ value: '../a/b' })]).toEqual([...encodeUtf8Strict({ value: '../a/b' })]);
    expect(() => encodePassphraseUtf8({ value: `\
line
feed` })).toThrow('line separator');
    expect([...encodePassphraseUtf8({ value: '  passphrase  ' })]).toEqual([...encodeUtf8Strict({ value: '  passphrase  ' })]);
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
