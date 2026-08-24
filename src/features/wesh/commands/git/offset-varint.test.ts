import { describe, expect, it } from 'vitest';
import { readOffsetVariableWidth, writeOffsetVariableWidth } from './offset-varint';

describe('wesh git offset variable-width decoder', () => {
  it.each([
    { bytes: [0x00], value: 0 },
    { bytes: [0x01], value: 1 },
    { bytes: [0x7f], value: 127 },
    { bytes: [0x80, 0x00], value: 128 },
    { bytes: [0x80, 0x01], value: 129 },
    { bytes: [0x81, 0x00], value: 256 },
  ])('decodes $value', ({ bytes, value }) => {
    expect(readOffsetVariableWidth({
      bytes: Uint8Array.from(bytes),
      offset: 0,
      label: 'test value',
    })).toEqual({ value, offset: bytes.length });
  });

  it.each([0, 1, 127, 128, 129, 255, 256, 16_384, 1_000_000])('round-trips %s through the writer', (value) => {
    const bytes = writeOffsetVariableWidth({ value, label: 'test value' });
    expect(readOffsetVariableWidth({ bytes, offset: 0, label: 'test value' })).toEqual({
      value,
      offset: bytes.byteLength,
    });
  });

  it('rejects a truncated continuation', () => {
    expect(() => readOffsetVariableWidth({
      bytes: Uint8Array.of(0x80),
      offset: 0,
      label: 'test value',
    })).toThrow('truncated test value');
  });
});
