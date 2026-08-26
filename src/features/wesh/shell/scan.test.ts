import { describe, expect, it } from 'vitest';
import { findBalancedParenthesizedExpression, findBracedParameterEnd } from './scan';

describe('shell balanced scanning', () => {
  it('keeps nested command-substitution quotes scoped inside an outer double quote', () => {
    const text = `$(printf '%s' "$(printf '%s' "a)b")")tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf '%s' "$(printf '%s' "a)b")"`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('ignores closing parentheses inside command-substitution comments', () => {
    const text = `$(printf x # ) is a comment
)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf x # ) is a comment
`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('does not treat a hash after escaped whitespace as a comment start', () => {
    const text = `$(printf \\ #)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf \\ #`,
      endIndex: text.indexOf('tail') - 1,
    });
  });


  it('keeps comment eligibility across a removed backslash-newline', () => {
    const text = `$(printf x; \\
# )) continued comment
printf y)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf x; \\
# )) continued comment
printf y`,
      endIndex: text.indexOf('tail') - 1,
    });
  });


  it('ignores closing braces inside double-quoted parameter operands', () => {
    const text = `${'${value:-"}"}'}tail`;

    expect(findBracedParameterEnd({ text, startIndex: 0 })).toBe(text.indexOf('tail') - 1);
  });

});
