import { describe, expect, it } from 'vitest';
import { parseDoubleQuotedParameterOperandParts, parseShellWordParts } from './word';

describe('double-quoted parameter operands', () => {
  it('uses unquoted backslash semantics while the surrounding double quote is toggled off', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '"a\\qb"' })).toEqual([
      {
        text: 'a',
        quoted: true,
        expandVariables: true,
      },
      {
        text: 'q',
        quoted: true,
        expandVariables: false,
      },
      {
        text: 'b',
        quoted: true,
        expandVariables: true,
      },
    ]);
  });

  it('keeps single quotes literal while the inner double-quote state is active', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '"\'$w\'"' })).toEqual([
      {
        text: "'$w'",
        quoted: true,
        expandVariables: true,
      },
    ]);
  });

  it('does not start ANSI-C quoting while the inner double-quote state is active', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '"$\'x y\'"' })).toEqual([
      {
        text: "$'x y'",
        quoted: true,
        expandVariables: true,
      },
    ]);
  });

  it('removes Bash locale-quote markers inside double-quoted parameter operands', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '$"abc"' })).toEqual([
      {
        text: 'abc',
        quoted: true,
        expandVariables: true,
      },
    ]);
    expect(parseDoubleQuotedParameterOperandParts({ raw: '$"a$x"' })).toEqual([
      {
        text: 'a$x',
        quoted: true,
        expandVariables: true,
      },
    ]);
  });

  it('removes the syntactic backslash before a closing brace', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '\\}' })).toEqual([
      {
        text: '}',
        quoted: true,
        expandVariables: false,
      },
    ]);
  });

  it('treats Bash locale-quoted words as double-quoted when no translation is applied', () => {
    expect(parseShellWordParts({ raw: '$"abc"' })).toEqual([
      { text: 'abc', quoted: true, expandVariables: true },
      { text: '', quoted: false, expandVariables: true },
    ]);
    expect(parseShellWordParts({ raw: 'pre$"a$x"post' })).toEqual([
      { text: 'pre', quoted: false, expandVariables: true },
      { text: 'a$x', quoted: true, expandVariables: true },
      { text: 'post', quoted: false, expandVariables: true },
    ]);
    expect(parseShellWordParts({ raw: '$""' })).toEqual([
      { text: '', quoted: true, expandVariables: true },
      { text: '', quoted: false, expandVariables: true },
    ]);
  });
});

describe('shell word literal runs', () => {
  it('keeps long unquoted literal runs intact around a command substitution', () => {
    const prefix = 'a'.repeat(4096);
    const raw = `${prefix}$(printf '%s' x)tail`;

    expect(parseShellWordParts({ raw })).toEqual([
      { text: raw, quoted: false, expandVariables: true },
    ]);
  });

  it('preserves expansion metadata around long double-quoted operand runs and escapes', () => {
    const prefix = 'b'.repeat(4096);

    expect(parseDoubleQuotedParameterOperandParts({ raw: `${prefix}\\$tail` })).toEqual([
      { text: prefix, quoted: true, expandVariables: true },
      { text: '$', quoted: true, expandVariables: false },
      { text: 'tail', quoted: true, expandVariables: true },
    ]);
  });
});
