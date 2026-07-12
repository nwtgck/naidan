import { describe, expect, it } from 'vitest';
import { formatJsonSource, tokenizeJson } from './json-syntax';

describe('json-syntax', () => {
  it('distinguishes object property names from string values', () => {
    const tokens = tokenizeJson({ source: '{"name":"Naidan","enabled":true,"count":3,"value":null}' });

    expect(tokens).toEqual(expect.arrayContaining([
      { type: 'property', text: '"name"' },
      { type: 'string', text: '"Naidan"' },
      { type: 'boolean', text: 'true' },
      { type: 'number', text: '3' },
      { type: 'null', text: 'null' },
    ]));
  });

  it('keeps escaped quotes inside one string token', () => {
    const tokens = tokenizeJson({ source: String.raw`{"value":"a\"b"}` });

    expect(tokens).toContainEqual({ type: 'string', text: String.raw`"a\"b"` });
    expect(tokens.filter(token => token.type === 'invalid')).toEqual([]);
  });

  it('marks unterminated strings and unexpected characters as invalid', () => {
    const tokens = tokenizeJson({ source: '{"value":"unterminated' });

    expect(tokens.at(-1)?.type).toBe('invalid');
  });

  it('formats valid JSON without regenerating persisted scalar tokens', () => {
    expect(formatJsonSource({
      source: '{"b":9007199254740993,"negativeZero":-0,"exponent":1e+09,"escaped":"a\\u0062"}',
    })).toEqual({
      status: 'valid',
      text: `\
{
  "b": 9007199254740993,
  "negativeZero": -0,
  "exponent": 1e+09,
  "escaped": "a\\u0062"
}`,
    });
  });

  it('preserves invalid source without attempting to reformat it', () => {
    expect(formatJsonSource({ source: '{broken' })).toEqual({
      status: 'invalid',
      text: '{broken',
    });
  });
});
