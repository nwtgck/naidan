import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readContractComments, unsafeDirectiveLocations } from './annotations.ts';
import { parseUnsafeSuppression, UNSAFE_SUPPRESSION_TAG } from './suppression.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import { printEffect } from '../contracts/effects.ts';

const definitions = [...DEFAULT_EFFECT_DEFINITIONS, { name: 'hoge', arguments: 'none' as const }];
const write = 'localstorage.write(*)';
const payload = JSON.stringify({ effects: [write], reason: 'Reviewed probe boundary.' });

function parse({ source }: { source: string }) {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  return readContractComments({ anchor: file.statements[0]!, definitions });
}

describe('explicit JSON unsafe effect suppression syntax', () => {
  it('accepts an operation row with a required reason', () => {
    const parsed = parseUnsafeSuppression({ text: JSON.stringify({ effects: [write, 'hoge'], reason: 'Reviewed probe boundary.' }), definitions });
    expect(parsed.effects.map(effect => printEffect({ effect }))).toEqual(['hoge', write]);
    expect(parsed.reason).toBe('Reviewed probe boundary.');
  });

  it('does not confuse delimiters in resources or reasons with JSON structure', () => {
    const reason = 'A -- reason, with & and `code`.';
    const parsed = parseUnsafeSuppression({ text: JSON.stringify({ effects: ['opfs.read("a,--&b")'], reason }), definitions });
    expect(parsed.effects.map(effect => printEffect({ effect }))).toEqual(['opfs.read("a,--&b")']);
    expect(parsed.reason).toBe(reason);
  });

  it.each([
    '', '`localstorage.write(*)` -- "Legacy"', '[]', 'null', '{}',
    '{"effects":["localstorage.write(*)"]}', '{"reason":"No"}',
    '{"effects":["localstorage.write(*)"],"reason":"No","extra":true}',
    '{"effects":["localstorage.write(*)"],"reason":"First","reason":"Second"}',
    ...[[], ['none'], ['none()'], ['call(arg0)'], ['opfs.raed(*)'], ['*'], ['localstorage.*(*)'], [write, 'call(arg0)']].map(effects => JSON.stringify({ effects, reason: 'No.' })),
    ...['', '  ', false, { reason: 'No' }, ['No'], `\
Reason
next`, 'Reason\u0000', 'Reason\u2028next', 'Reason\u2029next', 'x'.repeat(2049)].map(reason => JSON.stringify({ effects: [write], reason })),
    payload + ' trailing',
  ])('rejects missing, broad or malformed authority: %s', text => {
    expect(() => parseUnsafeSuppression({ text, definitions })).toThrow();
  });

  it('reads separate public and exception comments in either order without changing the reason', () => {
    const publicRow = '/** @effects [] */';
    const suppression = `/** ${UNSAFE_SUPPRESSION_TAG} ${payload} */`;
    for (const source of [`${publicRow}\n${suppression}\nfunction f() {}`, `${suppression}\n${publicRow}\nfunction f() {}`]) {
      const parsed = parse({ source });
      expect(parsed.annotation?.effects).toEqual([]);
      expect(parsed.suppression?.reason).toBe('Reviewed probe boundary.');
      expect(source.slice(parsed.suppression!.start, parsed.suppression!.end)).toBe(suppression);
    }
  });

  it('preserves UTF-16 offsets across CRLF and decorated multiline comments', () => {
    const source = [
      '// snowman: ☃ and astral: 😀', '/** @effects [] */', '/**',
      ` * ${UNSAFE_SUPPRESSION_TAG} {`, ' *   "effects": ["opfs.read(*)", "opfs.write(*)"],',
      ' *   "reason": "Reviewed capability probe."', ' * }', ' */', 'function probe() {}',
    ].join('\r\n');
    const result = parse({ source });
    expect(result.suppression?.effects.map(effect => printEffect({ effect }))).toEqual(['opfs.read(*)', 'opfs.write(*)']);
    expect(source.slice(result.suppression!.start, result.suppression!.end)).toContain(' *   "reason": "Reviewed capability probe."');
  });

  it('reports duplicate JSON keys at their original UTF-16 source offset', () => {
    const source = [
      '// ☃😀', '/**', ` * ${UNSAFE_SUPPRESSION_TAG} {`, ' * "effects": ["localstorage.write(*)"],',
      ' * "reason": "First",', ' * "reason": "Second"', ' * }', ' */', 'function f() {}',
    ].join('\r\n');
    try {
      parse({ source });
      throw new Error('Expected a duplicate-key diagnostic.');
    } catch (error) {
      expect(error).toMatchObject({ offset: source.lastIndexOf('"reason"') });
    }
  });

  it('rejects duplicate dedicated exception comments', () => {
    const directive = `/** ${UNSAFE_SUPPRESSION_TAG} ${payload} */`;
    expect(() => parse({ source: `${directive}\n${directive}\nfunction f() {}` })).toThrow('Multiple unsafe');
  });

  it('rejects misspelled reserved directives rather than ignoring them', () => {
    expect(() => parse({ source: '/** @effects-UNSAFE-SUPRESS ["hoge"] */ function f() {}' })).toThrow('Unknown effect directive');
  });

  it('does not find directives in literals, template contents or prose examples', () => {
    const source = `\
/** This is documentation: ${UNSAFE_SUPPRESSION_TAG} ${payload}. */
const example = '/** ${UNSAFE_SUPPRESSION_TAG} ${payload} */';
const template = \`/** ${UNSAFE_SUPPRESSION_TAG} text */\`;
const pattern = /@effectsUNSAFE/;
`;
    const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    expect(unsafeDirectiveLocations({ source: file })).toEqual([]);
    expect(readContractComments({ anchor: file.statements[0]!, definitions }).suppression).toBeUndefined();
  });

  it('locates a trailing unattached exception for ownership validation', () => {
    const source = `function f() {}\n/** ${UNSAFE_SUPPRESSION_TAG} ${payload} */`;
    const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    const positions = unsafeDirectiveLocations({ source: file });
    expect(positions).toHaveLength(1);
    expect(source.slice(positions[0]!.start, positions[0]!.end)).toContain('Reviewed probe boundary.');
  });
});
