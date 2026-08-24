import { describe, expect, it } from 'vitest';
import {
  parseCoreutilsLineOrByteCount,
  selectLastLineOrByteCount,
} from './line-byte-count-selection';

describe('parseCoreutilsLineOrByteCount', () => {
  it('normalizes decimal, binary, and historical lowercase multipliers', () => {
    expect(parseCoreutilsLineOrByteCount({ value: '1kB', errorPrefix: 'invalid' })).toEqual({
      ok: true,
      value: '1000',
    });
    expect(parseCoreutilsLineOrByteCount({ value: '-1KiB', errorPrefix: 'invalid' })).toEqual({
      ok: true,
      value: '-1024',
    });
    expect(parseCoreutilsLineOrByteCount({ value: '+1m', errorPrefix: 'invalid' })).toEqual({
      ok: true,
      value: '+1048576',
    });
  });


  it('accepts leading C-locale whitespace but rejects trailing and Unicode whitespace', () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      expect(parseCoreutilsLineOrByteCount({
        value: `${whitespace}2K`,
        errorPrefix: 'invalid count',
      })).toEqual({ ok: true, value: '2048' });
    }

    for (const value of ['2K ', '\u00a02K', '\u20032K', '\ufeff2K']) {
      expect(parseCoreutilsLineOrByteCount({ value, errorPrefix: 'invalid count' })).toEqual({
        ok: false,
        message: `invalid count: '${value}'`,
      });
    }
  });

  it('rejects unsupported multiplier spellings', () => {
    expect(parseCoreutilsLineOrByteCount({ value: '1XB', errorPrefix: 'invalid count' })).toEqual({
      ok: false,
      message: "invalid count: '1XB'",
    });
  });

  it('saturates enormous values without constructing an enormous bigint', () => {
    expect(parseCoreutilsLineOrByteCount({
      value: `${'0'.repeat(4096)}1K`,
      errorPrefix: 'invalid',
    })).toEqual({
      ok: true,
      value: '1024',
    });
    expect(parseCoreutilsLineOrByteCount({
      value: `${'9'.repeat(4096)}Q`,
      errorPrefix: 'invalid',
    })).toEqual({
      ok: true,
      value: String(Number.MAX_SAFE_INTEGER),
    });
  });
});

describe('selectLastLineOrByteCount', () => {
  it('uses the last relevant value occurrence and ignores unrelated flags', () => {
    expect(selectLastLineOrByteCount({
      occurrences: [
        { kind: 'value', option: '-c', key: 'bytes', value: '2' },
        { kind: 'flag', option: '-q', effects: [{ key: 'headerMode', value: 'never' }] },
        { kind: 'value', option: '-n', key: 'lines', value: '3' },
      ],
      defaultLineCount: '10',
    })).toEqual({ kind: 'lines', value: '3' });
  });
});
