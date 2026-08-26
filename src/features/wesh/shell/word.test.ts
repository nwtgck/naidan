import { describe, expect, it } from 'vitest';
import { parseDoubleQuotedParameterOperandParts } from './word';

describe('double-quoted parameter operands', () => {
  it('removes the syntactic backslash before a closing brace', () => {
    expect(parseDoubleQuotedParameterOperandParts({ raw: '\\}' })).toEqual([
      {
        text: '}',
        quoted: true,
        expandVariables: false,
      },
    ]);
  });
});
