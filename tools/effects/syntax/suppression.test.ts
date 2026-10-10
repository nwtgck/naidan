import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readContractComments, unsafeDirectiveLocations } from './annotations.ts';
import { parseUnsafeSuppression, UNSAFE_SUPPRESSION_TAG } from './suppression.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import { printEffect } from '../contracts/effects.ts';

const definitions = [...DEFAULT_EFFECT_DEFINITIONS, { name: 'hoge', arguments: 'none' as const }];
const write = '`localstorage.write(*)`';

function parse({ source }: { source: string }) {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  return readContractComments({ anchor: file.statements[0]!, definitions });
}

describe('explicit unsafe effect suppression syntax', () => {
  it.each([',', '&'])('accepts %s as an upper-bound list with a required reason', separator => {
    const parsed = parseUnsafeSuppression({ text: `${write} ${separator} \`hoge\` -- "Reviewed probe boundary."`, definitions });
    expect(parsed.effects.map(effect => printEffect({ effect }))).toEqual(['hoge', 'localstorage.write(*)']);
    expect(parsed.reason).toBe('Reviewed probe boundary.');
  });

  it('does not confuse delimiters in resources or reasons with the list structure', () => {
    const parsed = parseUnsafeSuppression({ text: '`opfs.read("a,--&b")` -- "A -- reason, with & and `code`."', definitions });
    expect(parsed.effects.map(effect => printEffect({ effect }))).toEqual(['opfs.read("a,--&b")']);
    expect(parsed.reason).toBe('A -- reason, with & and `code`.');
  });

  it.each([
    '', '`none` -- "No."', '`none()` -- "No."', '`call(arg0)` -- "No."',
    '`opfs.raed(*)` -- "No."', '`*` -- "No."', '`localstorage.*(*)` -- "No."',
    `${write}`, `${write} --`, `${write} -- ""`, `${write} -- "  "`,
    `${write} -- false`, `${write} -- {"reason":"No"}`, `${write} -- ["No"]`,
    `${write} -- 'single quotes'`, `${write} -- "Reason" trailing`,
    `${write} -- "Reason\\nnext"`, `${write} -- "Reason\\u0000"`,
    `${write} -- "Reason\\u2028next"`, `${write} -- "Reason\\u2029next"`,
    `${write} -- "${'x'.repeat(2049)}"`, `${write}, -- "No."`,
    `${write}, \`hoge\` & ${write} -- "No."`, `${write}, \`call(arg0)\` -- "No."`,
  ])('rejects missing, broad or malformed authority: %s', text => {
    expect(() => parseUnsafeSuppression({ text, definitions })).toThrow();
  });

  it('reads separate public and exception comments in either order', () => {
    const publicRow = '/** @effects `none` */';
    const suppression = `/** ${UNSAFE_SUPPRESSION_TAG} ${write} -- "Test boundary." */`;
    for (const source of [`${publicRow}\n${suppression}\nfunction f() {}`, `${suppression}\n${publicRow}\nfunction f() {}`]) {
      const parsed = parse({ source });
      expect(parsed.annotation?.effects).toEqual([]);
      expect(parsed.suppression?.reason).toBe('Test boundary.');
      expect(source.slice(parsed.suppression!.start, parsed.suppression!.end)).toBe(suppression);
    }
  });

  it('preserves UTF-16 offsets across CRLF and decorated multiline comments', () => {
    const source = [
      '// snowman: ☃ and astral: 😀', '/** @effects `none` */', '/**',
      ` * ${UNSAFE_SUPPRESSION_TAG} \`opfs.read(*)\`,`, ' *   `opfs.write(*)`',
      ' * -- "Reviewed capability probe."', ' */', 'function probe() {}',
    ].join('\r\n');
    const result = parse({ source });
    expect(result.suppression?.effects.map(effect => printEffect({ effect }))).toEqual(['opfs.read(*)', 'opfs.write(*)']);
    expect(source.slice(result.suppression!.start, result.suppression!.end)).toContain(' * -- "Reviewed capability probe."');
  });

  it('rejects duplicate dedicated exception comments', () => {
    const directive = `/** ${UNSAFE_SUPPRESSION_TAG} ${write} -- "Reviewed." */`;
    expect(() => parse({ source: `${directive}\n${directive}\nfunction f() {}` })).toThrow('Multiple unsafe');
  });

  it('rejects misspelled reserved directives rather than ignoring them', () => {
    expect(() => parse({ source: '/** @effects-UNSAFE-SUPRESS `hoge` -- "Typo." */ function f() {}' })).toThrow('Unknown effect directive');
  });

  it('does not find directives in literals, template contents or prose examples', () => {
    const source = `\
/** This is documentation: ${UNSAFE_SUPPRESSION_TAG} ${write}. */
const example = '/** ${UNSAFE_SUPPRESSION_TAG} ${write} -- "Example" */';
const template = \`/** ${UNSAFE_SUPPRESSION_TAG} text */\`;
const pattern = /@effectsUNSAFE/;
`;
    const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    expect(unsafeDirectiveLocations({ source: file })).toEqual([]);
    expect(readContractComments({ anchor: file.statements[0]!, definitions }).suppression).toBeUndefined();
  });

  it('locates a trailing unattached exception for ownership validation', () => {
    const source = `function f() {}\n/** ${UNSAFE_SUPPRESSION_TAG} ${write} -- "Orphan." */`;
    const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
    const positions = unsafeDirectiveLocations({ source: file });
    expect(positions).toHaveLength(1);
    expect(source.slice(positions[0]!.start, positions[0]!.end)).toContain('Orphan.');
  });
});
