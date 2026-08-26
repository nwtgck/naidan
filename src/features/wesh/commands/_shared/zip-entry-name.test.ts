import { describe, expect, it } from 'vitest';
import { decodeWeshZipEntryName } from '@/features/wesh/commands/_shared/zip-entry-name';

describe('decodeWeshZipEntryName', () => {
  it('preserves legacy raw entry-name bytes and decodes flagged UTF-8 names', () => {
    expect(decodeWeshZipEntryName({
      bytes: new Uint8Array([0x78, 0x82, 0x2e, 0x74, 0x78, 0x74]),
      isUtf8: false,
    })).toBe(`x${String.fromCharCode(0xdc82)}.txt`);
    expect(decodeWeshZipEntryName({
      bytes: new Uint8Array([0xc3, 0xa9, 0x2e, 0x74, 0x78, 0x74]),
      isUtf8: true,
    })).toBe('é.txt');
  });
});
