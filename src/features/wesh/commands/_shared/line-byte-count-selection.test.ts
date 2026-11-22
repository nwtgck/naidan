import { describe, expect, it } from 'vitest';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv';
import {
  lineOrByteCountArgvAction,
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
    const catalog = defineArgvCatalog<StandardArgvAction<never>>({
      definitions: [
        {
          semantic: lineOrByteCountArgvAction({ unit: 'bytes' }),
          forms: [{ kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'bytes' } }],
        },
        {
          semantic: lineOrByteCountArgvAction({ unit: 'lines' }),
          forms: [{ kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'lines' } }],
        },
        {
          semantic: { kind: 'effects', effects: [{ key: 'headerMode', value: 'never' }] },
          forms: [{ kind: 'short', name: 'q', value: { kind: 'none' } }],
        },
      ],
      nonExecutableLongOptions: [],
    });
    const parsed = parseStandardArgv({
      args: ['-c2', '-n3K', '-q'],
      catalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'continue', occurrenceRetention: 'all' },
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(selectLastLineOrByteCount({ parsed, defaultLineCount: '10' })).toEqual({ kind: 'lines', value: '3072' });
  });
});
