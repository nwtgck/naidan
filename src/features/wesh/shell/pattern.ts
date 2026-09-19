import { nextShellCharacterIndex } from './scan';

type WeshShellPatternPosixClass =
  | 'alnum'
  | 'alpha'
  | 'ascii'
  | 'blank'
  | 'cntrl'
  | 'digit'
  | 'graph'
  | 'lower'
  | 'print'
  | 'punct'
  | 'space'
  | 'upper'
  | 'word'
  | 'xdigit';

type WeshShellPatternCharacterClassItem =
  | {
    kind: 'literal',
    value: string,
  }
  | {
    kind: 'range',
    start: string,
    end: string,
  }
  | {
    kind: 'posix-class',
    value: WeshShellPatternPosixClass,
  };

type WeshShellPatternToken =
  | {
    kind: 'literal',
    value: string,
  }
  | {
    kind: 'any-character',
  }
  | {
    kind: 'any-string',
  }
  | {
    kind: 'character-class',
    negated: boolean,
    items: readonly WeshShellPatternCharacterClassItem[],
  };

export type WeshCompiledShellPattern =
  | {
    kind: 'never-match',
  }
  | {
    kind: 'literal',
    value: string,
  }
  | {
    kind: 'single-star',
    prefix: string,
    suffix: string,
  }
  | {
    kind: 'tokens',
    tokens: readonly WeshShellPatternToken[],
  };

function readCodePoint({
  text,
  index,
}: {
  text: string,
  index: number,
}): {
  value: string,
  nextIndex: number,
} {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return { value: '', nextIndex: index };
  }

  return {
    value: String.fromCodePoint(codePoint),
    nextIndex: index + (codePoint > 0xffff ? 2 : 1),
  };
}


function readEscapedPatternCharacter({
  pattern,
  index,
}: {
  pattern: string,
  index: number,
}): {
  value: string,
  nextIndex: number,
} {
  if (pattern[index] !== '\\') {
    return readCodePoint({ text: pattern, index });
  }

  const escaped = readCodePoint({
    text: pattern,
    index: index + 1,
  });
  if (escaped.value.length === 0) {
    return {
      value: '\\',
      nextIndex: index + 1,
    };
  }

  return {
    value: escaped.value,
    nextIndex: escaped.nextIndex,
  };
}

function parseCharacterClass({
  pattern,
  startIndex,
}: {
  pattern: string,
  startIndex: number,
}): {
  token: WeshShellPatternToken,
  nextIndex: number,
} | undefined {
  let index = startIndex + 1;
  let negated = false;
  const first = pattern[index];
  if (first === '!' || first === '^') {
    negated = true;
    index += 1;
  }

  const items: WeshShellPatternCharacterClassItem[] = [];
  let hasContent = false;

  if (pattern[index] === ']') {
    items.push({ kind: 'literal', value: ']' });
    index += 1;
    hasContent = true;
  }

  while (index < pattern.length) {
    if (pattern[index] === ']' && hasContent) {
      return {
        token: {
          kind: 'character-class',
          negated,
          items,
        },
        nextIndex: index + 1,
      };
    }

    if (pattern[index] === '[' && pattern[index + 1] === ':') {
      const classEnd = pattern.indexOf(':]', index + 2);
      if (classEnd >= 0) {
        const className = pattern.slice(index + 2, classEnd);
        const posixClass = (() => {
          switch (className) {
          case 'alnum':
          case 'alpha':
          case 'ascii':
          case 'blank':
          case 'cntrl':
          case 'digit':
          case 'graph':
          case 'lower':
          case 'print':
          case 'punct':
          case 'space':
          case 'upper':
          case 'word':
          case 'xdigit':
            return className;
          default:
            return undefined;
          }
        })();
        if (posixClass !== undefined) {
          items.push({ kind: 'posix-class', value: posixClass });
          index = classEnd + 2;
          hasContent = true;
          continue;
        }
      }
    }

    if (
      pattern[index] === '['
      && (pattern[index + 1] === '=' || pattern[index + 1] === '.')
    ) {
      const marker = pattern[index + 1]!;
      const itemEnd = pattern.indexOf(`${marker}]`, index + 2);
      if (itemEnd >= 0) {
        const itemValue = pattern.slice(index + 2, itemEnd);
        const codePoints = [...itemValue];
        if (codePoints.length === 1) {
          items.push({ kind: 'literal', value: codePoints[0]! });
          index = itemEnd + 2;
          hasContent = true;
          continue;
        }
      }
    }

    const firstCharacter = readEscapedPatternCharacter({
      pattern,
      index,
    });
    index = firstCharacter.nextIndex;
    hasContent = true;

    if (
      pattern[index] === '-' &&
      pattern[index + 1] !== undefined &&
      pattern[index + 1] !== ']'
    ) {
      const rangeEnd = readEscapedPatternCharacter({
        pattern,
        index: index + 1,
      });
      items.push({
        kind: 'range',
        start: firstCharacter.value,
        end: rangeEnd.value,
      });
      index = rangeEnd.nextIndex;
      continue;
    }

    items.push({
      kind: 'literal',
      value: firstCharacter.value,
    });
  }

  return undefined;
}

function pushLiteralPatternToken({
  tokens,
  value,
}: {
  tokens: WeshShellPatternToken[],
  value: string,
}): void {
  const previous = tokens.at(-1);
  if (previous !== undefined) {
    switch (previous.kind) {
    case 'literal':
      previous.value += value;
      return;
    case 'any-character':
    case 'any-string':
    case 'character-class':
      break;
    default: {
      const _ex: never = previous;
      throw new Error(`Unhandled shell pattern token: ${String(_ex)}`);
    }
    }
  }
  tokens.push({
    kind: 'literal',
    value,
  });
}

function joinLiteralPatternTokens({
  tokens,
  startIndex,
  endIndex,
}: {
  tokens: readonly WeshShellPatternToken[],
  startIndex: number,
  endIndex: number,
}): string {
  let result = '';
  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    switch (token.kind) {
    case 'literal':
      result += token.value;
      break;
    case 'any-string':
      break;
    case 'any-character':
    case 'character-class':
      throw new Error('Expected only literal and star shell pattern tokens');
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled shell pattern token: ${String(_ex)}`);
    }
    }
  }
  return result;
}

export function compileShellPattern({
  pattern,
}: {
  pattern: string,
}): WeshCompiledShellPattern {
  const tokens: WeshShellPatternToken[] = [];
  let previousWasStar = false;
  let starCount = 0;
  let firstStarIndex = -1;
  let literalOnly = true;

  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === undefined) {
      break;
    }

    if (character === '\\') {
      if (pattern[index + 1] === undefined) {
        return { kind: 'never-match' };
      }
      const literal = readEscapedPatternCharacter({
        pattern,
        index,
      });
      pushLiteralPatternToken({
        tokens,
        value: literal.value,
      });
      previousWasStar = false;
      index = literal.nextIndex;
      continue;
    }

    if (character === '*') {
      if (!previousWasStar) {
        if (starCount === 0) {
          firstStarIndex = tokens.length;
        }
        tokens.push({ kind: 'any-string' });
        starCount += 1;
      }
      previousWasStar = true;
      index += 1;
      continue;
    }

    if (character === '?') {
      tokens.push({ kind: 'any-character' });
      literalOnly = false;
      previousWasStar = false;
      index += 1;
      continue;
    }

    if (character === '[') {
      const characterClass = parseCharacterClass({
        pattern,
        startIndex: index,
      });
      if (characterClass !== undefined) {
        tokens.push(characterClass.token);
        literalOnly = false;
        previousWasStar = false;
        index = characterClass.nextIndex;
        continue;
      }
    }

    const literal = readCodePoint({ text: pattern, index });
    pushLiteralPatternToken({
      tokens,
      value: literal.value,
    });
    previousWasStar = false;
    index = literal.nextIndex;
  }

  if (literalOnly && starCount === 0) {
    return {
      kind: 'literal',
      value: joinLiteralPatternTokens({
        tokens,
        startIndex: 0,
        endIndex: tokens.length,
      }),
    };
  }

  if (literalOnly && starCount === 1) {
    const starIndex = firstStarIndex;
    const prefix = joinLiteralPatternTokens({
      tokens,
      startIndex: 0,
      endIndex: starIndex,
    });
    const suffix = joinLiteralPatternTokens({
      tokens,
      startIndex: starIndex + 1,
      endIndex: tokens.length,
    });
    return {
      kind: 'single-star',
      prefix,
      suffix,
    };
  }

  return {
    kind: 'tokens',
    tokens,
  };
}

function posixCharacterClassMatches({
  className,
  character,
}: {
  className: WeshShellPatternPosixClass,
  character: string,
}): boolean {
  const codePoint = character.codePointAt(0);
  const isAsciiUpper = codePoint !== undefined && codePoint >= 0x41 && codePoint <= 0x5a;
  const isAsciiLower = codePoint !== undefined && codePoint >= 0x61 && codePoint <= 0x7a;
  const isAsciiAlpha = isAsciiUpper || isAsciiLower;
  const isAsciiDigit = codePoint !== undefined && codePoint >= 0x30 && codePoint <= 0x39;
  switch (className) {
  case 'alnum':
    return isAsciiAlpha || isAsciiDigit;
  case 'alpha':
    return isAsciiAlpha;
  case 'ascii':
    return codePoint !== undefined && codePoint <= 0x7f;
  case 'blank':
    return character === ' ' || character === '\t';
  case 'cntrl':
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  case 'digit':
    return isAsciiDigit;
  case 'graph':
    return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e;
  case 'lower':
    return isAsciiLower;
  case 'print':
    return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e;
  case 'punct':
    return codePoint !== undefined && codePoint >= 0x21 && codePoint <= 0x7e && !isAsciiAlpha && !isAsciiDigit;
  case 'space':
    return character === ' ' || character === '\t' || character === '\n' || character === '\v' || character === '\f' || character === '\r';
  case 'upper':
    return isAsciiUpper;
  case 'word':
    return isAsciiAlpha || isAsciiDigit || character === '_';
  case 'xdigit':
    return isAsciiDigit ||
      (codePoint !== undefined && codePoint >= 0x41 && codePoint <= 0x46) ||
      (codePoint !== undefined && codePoint >= 0x61 && codePoint <= 0x66);
  default: {
    const _ex: never = className;
    throw new Error(`Unhandled POSIX shell character class: ${_ex}`);
  }
  }
}

function characterClassMatches({
  token,
  character,
}: {
  token: Extract<WeshShellPatternToken, { kind: 'character-class' }>,
  character: string,
}): boolean {
  let matched = false;

  for (const item of token.items) {
    switch (item.kind) {
    case 'literal':
      if (character === item.value) {
        matched = true;
      }
      break;
    case 'range':
      if (character >= item.start && character <= item.end) {
        matched = true;
      }
      break;
    case 'posix-class':
      if (posixCharacterClassMatches({
        className: item.value,
        character,
      })) {
        matched = true;
      }
      break;
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled shell pattern character class item: ${String(_ex)}`);
    }
    }

    if (matched) {
      break;
    }
  }

  return token.negated ? !matched : matched;
}

function matchesTokenShellPattern({
  compiledPattern,
  text,
}: {
  compiledPattern: Extract<WeshCompiledShellPattern, { kind: 'tokens' }>,
  text: string,
}): boolean {
  const { tokens } = compiledPattern;
  let tokenIndex = 0;
  let textIndex = 0;
  let lastStarTokenIndex: number | undefined;
  let lastStarTextIndex: number | undefined;

  while (textIndex < text.length) {
    const token = tokens[tokenIndex];
    if (token !== undefined) {
      switch (token.kind) {
      case 'any-string':
        lastStarTokenIndex = tokenIndex;
        lastStarTextIndex = textIndex;
        tokenIndex += 1;
        continue;
      case 'literal':
        if (text.startsWith(token.value, textIndex)) {
          tokenIndex += 1;
          textIndex += token.value.length;
          continue;
        }
        break;
      case 'any-character':
        tokenIndex += 1;
        textIndex = nextShellCharacterIndex({
          text,
          index: textIndex,
        });
        continue;
      case 'character-class': {
        const nextTextIndex = nextShellCharacterIndex({
          text,
          index: textIndex,
        });
        const character = nextTextIndex === textIndex + 1
          ? text[textIndex] ?? ''
          : text.slice(textIndex, nextTextIndex);
        if (characterClassMatches({ token, character })) {
          tokenIndex += 1;
          textIndex = nextTextIndex;
          continue;
        }
        break;
      }
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled shell pattern token: ${String(_ex)}`);
      }
      }
    }

    if (lastStarTokenIndex === undefined || lastStarTextIndex === undefined) {
      return false;
    }

    if (lastStarTextIndex >= text.length) {
      return false;
    }
    lastStarTextIndex = nextShellCharacterIndex({
      text,
      index: lastStarTextIndex,
    });
    textIndex = lastStarTextIndex;
    tokenIndex = lastStarTokenIndex + 1;
  }

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    if (token === undefined) {
      break;
    }
    switch (token.kind) {
    case 'any-string':
      tokenIndex += 1;
      continue;
    case 'literal':
    case 'any-character':
    case 'character-class':
      return false;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled trailing shell pattern token: ${String(_ex)}`);
    }
    }
  }

  return tokenIndex === tokens.length;
}


export function matchesCompiledShellPattern({
  compiledPattern,
  text,
}: {
  compiledPattern: WeshCompiledShellPattern,
  text: string,
}): boolean {
  switch (compiledPattern.kind) {
  case 'never-match':
    return false;
  case 'literal':
    return text === compiledPattern.value;
  case 'single-star':
    return (
      text.length >= compiledPattern.prefix.length + compiledPattern.suffix.length &&
      text.startsWith(compiledPattern.prefix) &&
      text.endsWith(compiledPattern.suffix)
    );
  case 'tokens':
    return matchesTokenShellPattern({ compiledPattern, text });
  default: {
    const _ex: never = compiledPattern;
    throw new Error(`Unhandled compiled shell pattern: ${String(_ex)}`);
  }
  }
}

export function matchesShellPattern({
  pattern,
  text,
}: {
  pattern: string,
  text: string,
}): boolean {
  return matchesCompiledShellPattern({
    compiledPattern: compileShellPattern({ pattern }),
    text,
  });
}

export function escapeShellPatternLiteral({
  text,
}: {
  text: string,
}): string {
  let firstMetaIndex = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (
      character === '\\' ||
      character === '*' ||
      character === '?' ||
      character === '[' ||
      character === ']'
    ) {
      firstMetaIndex = index;
      break;
    }
  }
  if (firstMetaIndex < 0) return text;

  const parts: string[] = [];
  let literalStart = 0;
  for (let index = firstMetaIndex; index < text.length; index += 1) {
    const character = text[index];
    if (
      character !== '\\' &&
      character !== '*' &&
      character !== '?' &&
      character !== '[' &&
      character !== ']'
    ) {
      continue;
    }
    if (index > literalStart) parts.push(text.slice(literalStart, index));
    parts.push('\\', character);
    literalStart = index + 1;
  }
  if (literalStart < text.length) parts.push(text.slice(literalStart));
  return parts.join('');
}

export function containsShellPatternMeta({
  pattern,
  extglob,
}: {
  pattern: string,
  extglob: 'enabled' | 'disabled',
}): boolean {
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === undefined) {
      break;
    }

    if (character === '\\') {
      const escaped = readEscapedPatternCharacter({
        pattern,
        index,
      });
      index = escaped.nextIndex;
      continue;
    }

    if (character === '*' || character === '?') {
      return true;
    }

    if (character === '[') {
      const characterClass = parseCharacterClass({
        pattern,
        startIndex: index,
      });
      if (characterClass !== undefined) {
        return true;
      }
    }

    if (
      extglob === 'enabled' &&
      (character === '@' || character === '!' || character === '+') &&
      pattern[index + 1] === '('
    ) {
      return true;
    }

    const literal = readCodePoint({ text: pattern, index });
    index = literal.nextIndex;
  }

  return false;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
