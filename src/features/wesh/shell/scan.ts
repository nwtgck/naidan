type ShellQuoteMode = 'unquoted' | 'single' | 'double';

export interface BalancedShellExpression {
  content: string,
  endIndex: number,
}

export function findBackquoteSubstitution({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text[startIndex] !== '`') return undefined;

  let escaped = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      return {
        content: text.slice(startIndex + 1, index),
        endIndex: index,
      };
    }
  }
  return undefined;
}

export function findBalancedParenthesizedExpression({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text[startIndex] !== '(') return undefined;

  let depth = 0;
  let mode: ShellQuoteMode = 'unquoted';
  let atWordStart = true;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) index = substitution.endIndex;
        continue;
      }
      if (character === '$' && text[index + 1] === '{') {
        const endIndex = findBracedParameterEnd({
          text,
          startIndex: index,
        });
        if (endIndex >= 0) index = endIndex;
        continue;
      }
      if (character === '$' && text[index + 1] === '(') {
        const expression = text[index + 2] === '('
          ? findBalancedArithmeticExpression({ text, startIndex: index })
          : findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
        if (expression !== undefined) index = expression.endIndex;
      }
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    if (character === '#') {
      if (atWordStart) {
        while (index + 1 < text.length) {
          const nextCharacter = text[index + 1];
          if (nextCharacter === '\n' || nextCharacter === '\r') break;
          index += 1;
        }
        atWordStart = true;
        continue;
      }
      atWordStart = false;
    }
    if (character === '`') {
      const substitution = findBackquoteSubstitution({ text, startIndex: index });
      if (substitution !== undefined) {
        index = substitution.endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === '$' && text[index + 1] === '{') {
      const endIndex = findBracedParameterEnd({
        text,
        startIndex: index,
      });
      if (endIndex >= 0) {
        index = endIndex;
        atWordStart = false;
        continue;
      }
    }
    if (character === "'") {
      mode = 'single';
      atWordStart = false;
      continue;
    }
    if (character === '"') {
      mode = 'double';
      atWordStart = false;
      continue;
    }
    if (character === '\\') {
      const nextCharacter = text[index + 1];
      if (nextCharacter === '\r' && text[index + 2] === '\n') {
        index += 2;
        continue;
      }
      if (nextCharacter === '\n') {
        index += 1;
        continue;
      }
      if (nextCharacter !== undefined) {
        atWordStart = false;
        index += 1;
      }
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      atWordStart = true;
      continue;
    }
    if (character === '(') {
      depth += 1;
      atWordStart = true;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(startIndex + 1, index),
          endIndex: index,
        };
      }
      atWordStart = true;
      continue;
    }
    if (character === ';' || character === '&' || character === '|' || character === '<' || character === '>') {
      atWordStart = true;
      continue;
    }
    atWordStart = false;
  }
  return undefined;
}

export function findBalancedArithmeticExpression({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): BalancedShellExpression | undefined {
  if (text.slice(startIndex, startIndex + 3) !== '$((') return undefined;

  let depth = 1;
  let mode: ShellQuoteMode = 'unquoted';
  for (let index = startIndex + 3; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') index += 1;
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    if (character === "'") {
      mode = 'single';
      continue;
    }
    if (character === '"') {
      mode = 'double';
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      if (depth > 1) {
        depth -= 1;
        continue;
      }
      if (nextCharacter === ')') {
        return {
          content: text.slice(startIndex + 3, index),
          endIndex: index + 1,
        };
      }
    }
  }
  return undefined;
}

export function findBracedParameterEnd({
  text,
  startIndex,
}: {
  text: string,
  startIndex: number,
}): number {
  if (text.slice(startIndex, startIndex + 2) !== '${') return -1;

  let depth = 1;
  let mode: ShellQuoteMode = 'unquoted';
  for (let index = startIndex + 2; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === "'") mode = 'unquoted';
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) {
          index = substitution.endIndex;
          continue;
        }
      }
      if (character !== '$') continue;
      break;
    case 'unquoted':
      if (character === '`') {
        const substitution = findBackquoteSubstitution({ text, startIndex: index });
        if (substitution !== undefined) {
          index = substitution.endIndex;
          continue;
        }
      }
      if (character === "'") {
        mode = 'single';
        continue;
      }
      if (character === '"') {
        mode = 'double';
        continue;
      }
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shell quote mode: ${_ex}`);
    }
    }

    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      if (text[index + 2] === '(') {
        const arithmetic = findBalancedArithmeticExpression({ text, startIndex: index });
        if (arithmetic !== undefined) index = arithmetic.endIndex;
        continue;
      }
      const substitution = findBalancedParenthesizedExpression({ text, startIndex: index + 1 });
      if (substitution !== undefined) index = substitution.endIndex;
      continue;
    }
    if (character === '$' && text[index + 1] === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}


export function nextShellCharacterIndex({
  text,
  index,
}: {
  text: string,
  index: number,
}): number {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return index;
  }
  return index + (codePoint > 0xffff ? 2 : 1);
}

export function previousShellCharacterIndex({
  text,
  index,
}: {
  text: string,
  index: number,
}): number {
  if (index <= 0) {
    return 0;
  }

  const trailingCodeUnit = text.charCodeAt(index - 1);
  if (
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    index >= 2
  ) {
    const leadingCodeUnit = text.charCodeAt(index - 2);
    if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
      return index - 2;
    }
  }

  return index - 1;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
