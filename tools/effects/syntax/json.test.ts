import { describe, expect, it } from 'vitest';
import { parseJsonPayload } from './json.ts';
import { EffectSyntaxError } from './error.ts';

describe('strict effect JSON payloads', () => {
  it('reads JSON without evaluating source or accepting JavaScript extensions', () => {
    expect(parseJsonPayload({ text: '{"@click":["network.http(*)"],"@input":[]}' })).toEqual({ '@click': ['network.http(*)'], '@input': [] });
    for (const text of ['["network.http(*)",]', '{"@click":[] /* explanation */}', "{'@click':[]}", '{"@click": undefined}']) {
      expect(() => parseJsonPayload({ text })).toThrow(EffectSyntaxError);
    }
  });

  it.each([
    '{"@click":[],"@click":["network.http(*)"]}',
    '{"effects":[],"reason":"first","reason":"second"}',
    '{"@click":[],"@\\u0063lick":["network.http(*)"]}',
    '[{"nested":{"effects":[],"effects":[]}}]',
  ])('rejects duplicate keys before JSON.parse loses them: %s', text => {
    expect(() => parseJsonPayload({ text })).toThrow('Duplicate JSON object key');
  });

  it('points at the second occurrence of a duplicate key', () => {
    const text = '{"@click":[],"@click":["network.http(*)"]}';
    try {
      parseJsonPayload({ text });
      throw new Error('Expected a duplicate-key diagnostic.');
    } catch (error) {
      expect(error).toBeInstanceOf(EffectSyntaxError);
      expect((error as EffectSyntaxError).offset).toBe(text.lastIndexOf('"@click"'));
    }
  });

  it('distinguishes structural keys from delimiter-like text inside strings', () => {
    expect(parseJsonPayload({ text: '{"reason":"{\\"a\\":0,\\"a\\":1}","effects":[]}' })).toEqual({ reason: '{"a":0,"a":1}', effects: [] });
    expect(parseJsonPayload({ text: '{"first":{"key":1},"second":{"key":2}}' })).toEqual({ first: { key: 1 }, second: { key: 2 } });
  });

  it('bounds payload length and converts parser stack exhaustion into a syntax diagnostic', () => {
    expect(() => parseJsonPayload({ text: ' '.repeat(65_537) })).toThrow('too long');
    expect(() => parseJsonPayload({ text: '['.repeat(8_000) + '0' + ']'.repeat(8_000) })).toThrow(EffectSyntaxError);
  });
});
