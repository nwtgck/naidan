import { describe, expect, it } from 'vitest';
import { parseParameterExpression } from './parameter-expression';

describe('parseParameterExpression', () => {
  it('removes the Bash parameter-substitution escape for replacement slashes', () => {
    expect(parseParameterExpression({ expression: String.raw`v/a/X\/Y` })).toEqual({
      kind: 'substitution',
      name: 'v',
      operator: 'first',
      pattern: 'a',
      replacement: 'X/Y',
    });
    expect(parseParameterExpression({ expression: String.raw`v/a/q\\/r` })).toEqual({
      kind: 'substitution',
      name: 'v',
      operator: 'first',
      pattern: 'a',
      replacement: String.raw`q\/r`,
    });
    expect(parseParameterExpression({ expression: String.raw`v/a/X\\\/Y` })).toMatchObject({
      replacement: String.raw`X\/Y`,
    });
    expect(parseParameterExpression({ expression: String.raw`v/a/X\\\\/Y` })).toMatchObject({
      replacement: String.raw`X\\/Y`,
    });
    expect(parseParameterExpression({ expression: String.raw`v/a/X\\\\\/Y` })).toMatchObject({
      replacement: String.raw`X\\/Y`,
    });
  });

  it('does not treat slashes inside nested shell expansions as substitution separators', () => {
    expect(parseParameterExpression({ expression: 'v/${p:-a/b}/X' })).toMatchObject({
      kind: 'substitution',
      pattern: '${p:-a/b}',
      replacement: 'X',
    });
    expect(parseParameterExpression({ expression: "v/$(printf 'a/b')/X" })).toMatchObject({
      kind: 'substitution',
      pattern: "$(printf 'a/b')",
      replacement: 'X',
    });
    expect(parseParameterExpression({ expression: 'v/$((1 / 1))/X' })).toMatchObject({
      kind: 'substitution',
      pattern: '$((1 / 1))',
      replacement: 'X',
    });
    expect(parseParameterExpression({ expression: "v/`printf 'a/b'`/X" })).toMatchObject({
      kind: 'substitution',
      pattern: "`printf 'a/b'`",
      replacement: 'X',
    });
  });

  it('preserves replacement backslashes that do not escape the slash delimiter', () => {
    expect(parseParameterExpression({ expression: String.raw`v/a/\&` })).toMatchObject({
      kind: 'substitution',
      replacement: String.raw`\&`,
    });
  });
});
