import { describe, expect, it } from 'vitest';
import {
  createBinaryHexRows,
  formatBinaryOffset,
  formatBinaryRange,
  formatBytesAsHex,
} from './binary-hex';

describe('binary hex formatting', () => {
  it('preserves physical offsets and renders printable ASCII beside raw hex', () => {
    const rows = createBinaryHexRows({
      bytes: new Uint8Array([
        0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00,
        0x20, 0x7e, 0x1f,
      ]),
      baseOffset: 0x20,
      bytesPerRow: 8,
    });

    expect(rows).toEqual([
      {
        offset: 0x20,
        offsetLabel: '0x00000020',
        hexGroups: ['48', '49', '5a', '4f', '46', '53', '00', '00'],
        ascii: 'HIZOFS..',
      },
      {
        offset: 0x28,
        offsetLabel: '0x00000028',
        hexGroups: ['20', '7e', '1f'],
        ascii: ' ~.',
      },
    ]);
  });

  it('formats exact inclusive ranges without converting bytes into JSON values', () => {
    expect(formatBinaryOffset({ offset: 10 })).toBe('0x0000000a');
    expect(formatBinaryRange({ offset: 10, byteLength: 2 })).toBe(
      '0x0000000a..0x0000000b',
    );
    expect(formatBinaryRange({ offset: 16, byteLength: 0 })).toBe(
      '0x00000010 (empty)',
    );
    expect(formatBytesAsHex({ bytes: new Uint8Array([0, 15, 255]) })).toBe(
      '00 0f ff',
    );
  });
});
