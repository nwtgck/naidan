import { describe, expect, it } from 'vitest';
import { parseEffects, printEffects } from './expression.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import { effectsContained, type Effect } from '../contracts/effects.ts';

const definitions = [...DEFAULT_EFFECT_DEFINITIONS, { name: 'hoge', arguments: 'none' as const }];

describe('effect grammar and upper bounds', () => {
  it.each([',', '&'])('uses %s for an upper-bound union, not intersection', separator => {
    const target = parseEffects({ text: '`localstorage.write(*)` ' + separator + ' `hoge`', definitions });
    for (const text of ['`none`', '`hoge`', '`localstorage.write(*)`', '`hoge`, `localstorage.write(*)`']) {
      expect(effectsContained({ source: parseEffects({ text, definitions }), target })).toBe(true);
    }
    expect(effectsContained({ source: parseEffects({ text: '`network.http(*)`', definitions }), target })).toBe(false);
  });

  it.each([
    '', '`none()`', '`none(localstorage.write(*))`', '`none`, `hoge`', '`none`, `none`',
    '`hoge`,', '`hoge`,, `hoge`', '`opfs.read(*)` `opfs.write(*)`', '`hoge`, `hoge` & `hoge`',
    'opfs.read(*)', '`unknown(*)`', '`opfs.raed(*)`', '`opfs.read`', '`hoge(*)`', '`call(*)`',
    '`opfs.read("unfinished)`', '`opfs.read("bad\\q")`', `\
\`opfs.read("x
y")\``, '`opfs.read(*)',
    '`opfs.read(*)` explanation', '`opfs.read((nested))`',
  ])('rejects malformed or ambiguous input: %s', text => {
    expect(() => parseEffects({ text, definitions })).toThrow();
  });

  it('parses delimiters inside resource strings structurally', () => {
    expect(printEffects({ effects: parseEffects({ text: '`opfs.read("a,b&c.json")`, `call(arg0.operation)`', definitions }) }))
      .toBe('`call(arg0.operation)`, `opfs.read("a,b&c.json")`');
  });

  it('does not make write imply read', () => {
    expect(effectsContained({ source: parseEffects({ text: '`opfs.read(*)`', definitions }), target: parseEffects({ text: '`opfs.write(*)`', definitions }) })).toBe(false);
  });

  it('distinguishes a wildcard from a literal star', () => {
    const all = parseEffects({ text: '`opfs.read(*)`', definitions });
    const star = parseEffects({ text: '`opfs.read("*")`', definitions });
    expect(effectsContained({ source: star, target: all })).toBe(true);
    expect(effectsContained({ source: all, target: star })).toBe(false);
  });

  it('prints comment and code-span delimiters without terminating the comment', () => {
    const effect: Effect = { kind: 'operation', name: 'opfs.read', target: { kind: 'literal', value: '**/*.json`' } };
    const printed = printEffects({ effects: [effect] });
    expect(printed).not.toContain('*/');
    expect(parseEffects({ text: printed, definitions })).toEqual([effect]);
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
