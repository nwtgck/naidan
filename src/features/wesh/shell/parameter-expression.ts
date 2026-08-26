import { isAsciiShellIdentifierPart, isAsciiShellIdentifierStart } from './ascii';
import {
  findBackquoteSubstitution,
  findBalancedArithmeticExpression,
  findBalancedParenthesizedExpression,
  findBracedParameterEnd,
} from './scan';

type ParameterValueOperator = ':-' | '-' | ':=' | '=' | ':?' | '?' | ':+' | '+';
type ParameterPatternOperator = '##' | '#' | '%%' | '%';
type ParameterCaseOperator = '^' | '^^' | ',' | ',,';
type ParameterSubstitutionOperator = 'first' | 'all' | 'prefix' | 'suffix';

export type ParsedParameterExpression =
  | {
    kind: 'indirect',
    name: string,
  }
  | {
    kind: 'value-operator',
    name: string,
    operator: ParameterValueOperator,
    operand: string,
  }
  | {
    kind: 'substring',
    name: string,
    offsetExpression: string,
    lengthExpression: string | undefined,
  }
  | {
    kind: 'pattern-operator',
    name: string,
    operator: ParameterPatternOperator,
    pattern: string,
  }
  | {
    kind: 'case-operator',
    name: string,
    operator: ParameterCaseOperator,
  }
  | {
    kind: 'substitution',
    name: string,
    operator: ParameterSubstitutionOperator,
    pattern: string,
    replacement: string,
  };

function readParameterNameEnd({ text, startIndex }: { text: string, startIndex: number }): number | undefined {
  const firstCharacter = text[startIndex];
  if (isAsciiShellIdentifierStart({ value: firstCharacter })) {
    let index = startIndex + 1;
    while (isAsciiShellIdentifierPart({ value: text[index] })) index += 1;
    return index;
  }

  if (firstCharacter !== undefined && firstCharacter >= '0' && firstCharacter <= '9') {
    let index = startIndex + 1;
    while (text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9') index += 1;
    return index;
  }

  switch (firstCharacter) {
  case '@':
  case '*':
  case '?':
  case '$':
  case '#':
  case '!':
  case '-':
    return startIndex + 1;
  default:
    return undefined;
  }
}

function parseValueOperator({ rest }: { rest: string }): {
  operator: ParameterValueOperator,
  operand: string,
} | undefined {
  const twoCharacter = rest.slice(0, 2);
  switch (twoCharacter) {
  case ':-':
  case ':=':
  case ':?':
  case ':+':
    return {
      operator: twoCharacter,
      operand: rest.slice(2),
    };
  default:
    break;
  }

  const oneCharacter = rest[0];
  switch (oneCharacter) {
  case '-':
  case '=':
  case '?':
  case '+':
    return {
      operator: oneCharacter,
      operand: rest.slice(1),
    };
  default:
    return undefined;
  }
}

function parsePatternOperator({ rest }: { rest: string }): {
  operator: ParameterPatternOperator,
  pattern: string,
} | undefined {
  const twoCharacter = rest.slice(0, 2);
  switch (twoCharacter) {
  case '##':
  case '%%':
    return {
      operator: twoCharacter,
      pattern: rest.slice(2),
    };
  default:
    break;
  }

  const oneCharacter = rest[0];
  switch (oneCharacter) {
  case '#':
  case '%':
    return {
      operator: oneCharacter,
      pattern: rest.slice(1),
    };
  default:
    return undefined;
  }
}


function findUnescapedSlash({ text, startIndex }: { text: string, startIndex: number }): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '`') {
      const substitution = findBackquoteSubstitution({ text, startIndex: index });
      if (substitution !== undefined) {
        index = substitution.endIndex;
        continue;
      }
    }
    if (text[index] === '$' && text[index + 1] === '{') {
      const endIndex = findBracedParameterEnd({ text, startIndex: index });
      if (endIndex >= 0) {
        index = endIndex;
        continue;
      }
    }
    if (text[index] === '$' && text[index + 1] === '(') {
      const expression = text[index + 2] === '('
        ? findBalancedArithmeticExpression({ text, startIndex: index })
        : findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
      if (expression !== undefined) {
        index = expression.endIndex;
        continue;
      }
    }
    if (text[index] === '/') return index;
  }
  return -1;
}

function unescapeSubstitutionReplacementSlashes({ replacement }: { replacement: string }): string {
  let result = '';
  for (let index = 0; index < replacement.length;) {
    if (replacement[index] !== '\\') {
      result += replacement[index] ?? '';
      index += 1;
      continue;
    }

    let runEnd = index;
    while (replacement[runEnd] === '\\') runEnd += 1;
    if (replacement[runEnd] !== '/') {
      result += replacement.slice(index, runEnd);
      index = runEnd;
      continue;
    }

    const backslashCount = runEnd - index;
    result += '\\'.repeat(Math.floor(backslashCount / 2));
    result += '/';
    index = runEnd + 1;
  }
  return result;
}

function parseSubstitutionOperator({ rest }: { rest: string }): {
  operator: ParameterSubstitutionOperator,
  pattern: string,
  replacement: string,
} | undefined {
  if (!rest.startsWith('/')) return undefined;

  let operator: ParameterSubstitutionOperator = 'first';
  let patternStart = 1;
  switch (rest[1]) {
  case '/':
    operator = 'all';
    patternStart = 2;
    break;
  case '#':
    operator = 'prefix';
    patternStart = 2;
    break;
  case '%':
    operator = 'suffix';
    patternStart = 2;
    break;
  default:
    break;
  }

  const separator = findUnescapedSlash({ text: rest, startIndex: patternStart });
  return {
    operator,
    pattern: separator < 0 ? rest.slice(patternStart) : rest.slice(patternStart, separator),
    replacement: separator < 0
      ? ''
      : unescapeSubstitutionReplacementSlashes({ replacement: rest.slice(separator + 1) }),
  };
}

export function parseParameterExpression({ expression }: { expression: string }): ParsedParameterExpression | undefined {
  if (expression.startsWith('!')) {
    const identifierEnd = readParameterNameEnd({ text: expression, startIndex: 1 });
    if (identifierEnd === expression.length) {
      return {
        kind: 'indirect',
        name: expression.slice(1),
      };
    }
  }

  const identifierEnd = readParameterNameEnd({ text: expression, startIndex: 0 });
  if (identifierEnd === undefined) return undefined;

  const name = expression.slice(0, identifierEnd);
  const rest = expression.slice(identifierEnd);

  const substitutionOperator = parseSubstitutionOperator({ rest });
  if (substitutionOperator !== undefined) {
    return {
      kind: 'substitution',
      name,
      operator: substitutionOperator.operator,
      pattern: substitutionOperator.pattern,
      replacement: substitutionOperator.replacement,
    };
  }

  const valueOperator = parseValueOperator({ rest });
  if (valueOperator !== undefined) {
    return {
      kind: 'value-operator',
      name,
      operator: valueOperator.operator,
      operand: valueOperator.operand,
    };
  }

  if (rest.startsWith(':')) {
    const secondColon = rest.indexOf(':', 1);
    const offsetExpression = secondColon === -1 ? rest.slice(1) : rest.slice(1, secondColon);
    if (offsetExpression.length > 0) {
      return {
        kind: 'substring',
        name,
        offsetExpression,
        lengthExpression: secondColon === -1 ? undefined : rest.slice(secondColon + 1),
      };
    }
  }

  const caseOperator = (() => {
    switch (rest) {
    case '^':
    case '^^':
    case ',':
    case ',,':
      return rest;
    default:
      return undefined;
    }
  })();
  if (caseOperator !== undefined) {
    return {
      kind: 'case-operator',
      name,
      operator: caseOperator,
    };
  }

  const patternOperator = parsePatternOperator({ rest });
  if (patternOperator !== undefined) {
    return {
      kind: 'pattern-operator',
      name,
      operator: patternOperator.operator,
      pattern: patternOperator.pattern,
    };
  }

  return undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
