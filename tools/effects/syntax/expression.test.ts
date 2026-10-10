import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseEffectRow, parseEffects, printEffects } from './expression.ts';
import { readAnnotation } from './annotations.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import { effectsContained, type Effect } from '../contracts/effects.ts';

const definitions = [...DEFAULT_EFFECT_DEFINITIONS, { name: 'hoge', arguments: 'none' as const }];

describe('JSON effect rows and upper bounds', () => {
  it('uses an array as an upper-bound union', () => {
    const target = parseEffects({ text: '["localstorage.write(*)", "hoge"]', definitions });
    for (const text of ['[]', '["hoge"]', '["localstorage.write(*)"]', '["hoge", "localstorage.write(*)"]']) {
      expect(effectsContained({ source: parseEffects({ text, definitions }), target })).toBe(true);
    }
    expect(effectsContained({ source: parseEffects({ text: '["network.http(*)"]', definitions }), target })).toBe(false);
  });

  it.each([
    '', '`none`', '`opfs.read(*)`, `opfs.write(*)`', '"opfs.read(*)"', '{}', 'null',
    '[false]', '[1]', '[null]', '[{}]', '[[]]', '["hoge",]', '["hoge"] explanation',
    '["none"]', '["none()"]', '["none(localstorage.write(*))"]',
    '["unknown(*)"]', '["opfs.raed(*)"]', '["opfs.read"]', '["hoge(*)"]', '["call(*)"]',
    '["opfs.read(*)"] /* prose */',
  ])('rejects malformed, non-array or legacy input: %s', text => {
    expect(() => parseEffects({ text, definitions })).toThrow();
  });

  it.each([
    'opfs.read(*)`', '`opfs.read(*)`', 'opfs.read(*) explanation',
    'opfs.read(*) & opfs.write(*)', 'opfs.read(*), opfs.write(*)',
    '`opfs.read(*)`, `opfs.write(*)`', 'opfs.read(*)`, `opfs.write(*)',
    'opfs.read("unfinished)', 'opfs.read("bad\\q")', 'opfs.read((nested))',
    `\
opfs.read("x
y")`, 'call(arg0) extra',
  ])('requires exactly one atom per JSON item: %s', atom => {
    expect(() => parseEffectRow({ value: [atom], definitions })).toThrow();
  });

  it('parses delimiters inside resource strings structurally', () => {
    const effects = parseEffectRow({ value: ['opfs.read("a,b&c.json")', 'call(arg0.operation)'], definitions });
    expect(printEffects({ effects })).toBe('["call(arg0.operation)","opfs.read(\\"a,b&c.json\\")"]');
  });

  it('does not make write imply read', () => {
    expect(effectsContained({ source: parseEffects({ text: '["opfs.read(*)"]', definitions }), target: parseEffects({ text: '["opfs.write(*)"]', definitions }) })).toBe(false);
  });

  it('distinguishes a wildcard from a literal star', () => {
    const all = parseEffectRow({ value: ['opfs.read(*)'], definitions });
    const star = parseEffectRow({ value: ['opfs.read("*")'], definitions });
    expect(effectsContained({ source: star, target: all })).toBe(true);
    expect(effectsContained({ source: all, target: star })).toBe(false);
  });

  it('prints comment delimiters safely and round-trips through the TypeScript scanner', () => {
    const effect: Effect = { kind: 'operation', name: 'opfs.read', target: { kind: 'literal', value: '**/*.json`"\\\n☃' } };
    const printed = printEffects({ effects: [effect] });
    expect(printed).not.toContain('*/');
    expect(parseEffects({ text: printed, definitions })).toEqual([effect]);
    const source = ts.createSourceFile('fixture.ts', `/** @effects ${printed} */ function inspect() {}`, ts.ScriptTarget.Latest, true);
    expect(source.statements).toHaveLength(1);
    expect(readAnnotation({ anchor: source.statements[0]!, definitions })?.effects).toEqual([effect]);
  });

  it('prints the empty row as [] and sorts and deduplicates atoms', () => {
    expect(printEffects({ effects: [] })).toBe('[]');
    const effects = parseEffectRow({ value: ['opfs.write(*)', 'hoge', 'opfs.write(*)'], definitions });
    expect(printEffects({ effects })).toBe('["hoge","opfs.write(*)"]');
  });

  it('identifies an invalid decoded item without treating its local offset as a source offset', () => {
    try {
      parseEffectRow({ value: ['hoge', 'opfs.read(*) trailing'], definitions });
      throw new Error('Expected an invalid atom diagnostic.');
    } catch (error) {
      expect(error).toMatchObject({ message: expect.stringContaining('Effect item 2:'), offset: 0 });
    }
    expect(() => parseEffectRow({ value: ['none'], definitions: [...definitions, { name: 'none', arguments: 'none' }] })).toThrow('Use []');
  });

  it('round-trips generated resource strings deterministically', () => {
    let state = 137;
    for (let index = 0; index < 500; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const effect: Effect = { kind: 'operation', name: 'opfs.read', target: { kind: 'literal', value: `a,${state}&\n\t\\"\u2603` } };
      expect(parseEffects({ text: printEffects({ effects: [effect] }), definitions })).toEqual([effect]);
    }
  });
});
