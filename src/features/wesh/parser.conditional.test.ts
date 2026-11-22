import { describe, expect, it } from 'vitest';
import { parseCommandLine, parseNextShellUnit } from './parser';

describe('Shell conditional grammar', () => {
  it('keeps raw operands and groups negation, conjunction, and disjunction by precedence', () => {
    expect(parseCommandLine({ commandLine: '[[ ! "$x" -eq \'2+3\' && ((a -lt b)) || -n \'&&\' ]]' })).toEqual({
      kind: 'conditionalCommand',
      expression: {
        kind: 'or',
        operands: [
          {
            kind: 'and',
            operands: [
              { kind: 'not', operand: { kind: 'binary', operator: '-eq', left: '"$x"', right: "'2+3'" } },
              { kind: 'binary', operator: '-lt', left: 'a', right: 'b' },
            ],
          },
          { kind: 'unary', operator: '-n', word: "'&&'" },
        ],
      },
    });
  });

  it.each([
    '(foo|bar)',
    'a||b',
    '|',
  ])('reads %s as a single unquoted regular expression operand', (right) => {
    expect(parseCommandLine({ commandLine: `[[ foo =~ ${right} ]]` })).toEqual({
      kind: 'conditionalCommand',
      expression: { kind: 'binary', operator: '=~', left: 'foo', right },
    });
  });

  it('treats a separated Boolean operator after a regular expression as syntax', () => {
    expect(parseCommandLine({ commandLine: '[[ foo =~ (foo|bar) || foo -eq 0 ]]' })).toEqual({
      kind: 'conditionalCommand',
      expression: {
        kind: 'or',
        operands: [
          { kind: 'binary', operator: '=~', left: 'foo', right: '(foo|bar)' },
          { kind: 'binary', operator: '-eq', left: 'foo', right: '0' },
        ],
      },
    });
  });

  it('recognizes compact negation without interpreting an extglob operand as negation', () => {
    expect(parseCommandLine({ commandLine: '[[ !(x == !(y)) ]]' })).toEqual({
      kind: 'conditionalCommand',
      expression: {
        kind: 'not',
        operand: { kind: 'binary', operator: '==', left: 'x', right: '!(y)' },
      },
    });
  });

  it('parses process substitutions in standalone, unary, and binary operands', () => {
    const input = { kind: 'processSubstitution', type: 'input', list: { kind: 'command', name: 'true' } };
    const output = { kind: 'processSubstitution', type: 'output', list: { kind: 'command', name: 'cat' } };
    expect(parseCommandLine({ commandLine: '[[ (<(true))&& -n >(cat) || <(true) =~ >(cat) ]]' })).toMatchObject({
      kind: 'conditionalCommand',
      expression: {
        kind: 'or',
        operands: [
          {
            kind: 'and',
            operands: [
              { kind: 'word', word: input },
              { kind: 'unary', operator: '-n', word: output },
            ],
          },
          { kind: 'binary', operator: '=~', left: input, right: output },
        ],
      },
    });
  });

  it.each(['"!"', '"&&"', '"]]"', '-eq'])('preserves the conditional word %s', (word) => {
    expect(parseCommandLine({ commandLine: `[[ ${word} ]]` })).toEqual({
      kind: 'conditionalCommand',
      expression: { kind: 'word', word },
    });
  });

  it('recognizes operators and the closing delimiter across backslash-newline', () => {
    const commandLine = `\
[[ 1 -e\\
q 1 ]\\
]`;
    expect(parseCommandLine({ commandLine })).toEqual({
      kind: 'conditionalCommand',
      expression: { kind: 'binary', operator: '-eq', left: '1', right: '1' },
    });
  });

  it.each([
    '[[ 1 -eq 1 || 1 -eq ]]',
    '[[ a -eq a -eq a ]]',
    '[[ a "$operator" a ]]',
    '[[ a "-eq" a ]]',
    `\
[[ a -eq
1 ]]`,
    `\
[[ -n
x ]]`,
    '[[ a ; b ]]',
    '[[ a =~ (a|b ]]',
    '[[ ( a ]]',
    '[[ <(true)]]',
    '[[ <(true)\\\n]]',
    '[[ <(true)== x ]]',
  ])('rejects incomplete or invalid conditional syntax in %j', (commandLine) => {
    expect(() => parseCommandLine({ commandLine })).toThrow();
  });

  it.each([
    '[[',
    '[[ 1 -e',
    '[[ 1 -eq',
    '[[ 1 -eq 1 ]',
    '[[ 1 -eq 1 |',
    '[[ foo =~ (foo|',
    '[[ <',
    '[[ -n >',
    '[[ 1 -eq <',
    '[[ <(true',
    '[[ <(true)',
    '[[ <(true) -e',
    '[[ <(true) == >(cat) ]',
  ])('waits for more streamed input after %j', (commandLine) => {
    expect(parseNextShellUnit({ commandLine, sourceCompletion: 'may-continue' })).toEqual({
      kind: 'needs-more-source',
    });
  });

  it('rejects a newline inside a comparison before waiting for more input', () => {
    expect(() => parseNextShellUnit({
      commandLine: '[[ a -eq\n',
      sourceCompletion: 'may-continue',
    })).toThrow('Expected a conditional operand');
  });

  it.each([
    `\
[[ a # comment
 && a ]]`,
    `\
[[ a
]]`,
    `\
[[ ( a
) ]]`,
    `\
[[ ! a
]]`,
  ])('requires a conditional operator or terminator after a standalone word in %j', (commandLine) => {
    expect(() => parseCommandLine({ commandLine })).toThrow('Expected a conditional binary operator');
  });

  it.each(['-n a', 'a == a', '( a )'])('allows a newline after a complete %s term', (term) => {
    const commandLine = `\
[[ ${term}
&& a ]]`;
    expect(parseCommandLine({ commandLine })).toMatchObject({
      kind: 'conditionalCommand',
      expression: { kind: 'and' },
    });
  });

  it('consumes the pending here-document and ends the unit after a multiline conditional', () => {
    const conditionalUnit = `\
cat <<TXT; [[ 1 -eq 1 &&
hello
TXT
2 -eq 2
]]
`;
    expect(parseNextShellUnit({
      commandLine: conditionalUnit + 'printf next\n',
      sourceCompletion: 'may-continue',
    })).toMatchObject({
      kind: 'parsed',
      consumedCharacters: conditionalUnit.length,
      node: {
        kind: 'list',
        parts: [
          { node: { kind: 'command', name: 'cat', redirections: [{ type: 'heredoc', content: 'hello\n' }] } },
          { node: { kind: 'conditionalCommand', expression: { kind: 'and' } } },
        ],
      },
    });
  });

  it('keeps compound redirections on the conditional pipeline stage', () => {
    expect(parseCommandLine({ commandLine: '[[ 1/0 -eq 0 ]] 2>errors |& cat' })).toMatchObject({
      kind: 'pipeline',
      commands: [
        {
          kind: 'redirected',
          node: { kind: 'conditionalCommand' },
          redirections: [
            { fd: 2, type: 'write', target: 'errors' },
            { fd: 2, type: 'dup_output', targetFd: 1 },
          ],
        },
        { kind: 'command', name: 'cat' },
      ],
    });
  });

  it.each(['"[[" 1 -eq 1 "]]"', 'command [[ 1 -eq 1 ]]', 'a=5 [[ 1 -eq 1 ]]'])(
    'keeps %s in the ordinary command grammar',
    (commandLine) => {
      expect(parseCommandLine({ commandLine })).toMatchObject({ kind: 'command' });
    },
  );
});
