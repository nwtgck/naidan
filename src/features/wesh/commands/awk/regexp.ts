import { compilePosixCompatibleRegExp } from '@/features/wesh/commands/_shared/posix-regexp';

function escapeAwkRegexLiteralCharacter({ character }: { character: string }): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return '';
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, '0')}`
    : `\\u{${codePoint.toString(16)}}`;
}

function decodeAwkDynamicRegexSingleCharacterEscape({
  escaped,
}: {
  escaped: string,
}): string | undefined {
  switch (escaped) {
  case 'a': return '\x07';
  case 'b': return '\b';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\x0b';
  default: return undefined;
  }
}

function normalizeAwkDynamicRegexEscapes({ source }: { source: string }): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== '\\' || index + 1 >= source.length) {
      result += character;
      continue;
    }

    const escaped = source[index + 1]!;
    const decoded = decodeAwkDynamicRegexSingleCharacterEscape({ escaped });
    if (decoded !== undefined) {
      result += escapeAwkRegexLiteralCharacter({ character: decoded });
      index += 1;
      continue;
    }

    if (/^[0-7]$/u.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /^[0-7]$/u.test(source[index + 2] ?? '')) {
        index += 1;
        digits += source[index + 1]!;
      }
      result += escapeAwkRegexLiteralCharacter({
        character: String.fromCharCode(Number.parseInt(digits, 8) & 0xff),
      });
      index += 1;
      continue;
    }

    if (escaped === 'x') {
      let digits = '';
      while (digits.length < 2 && /^[0-9A-Fa-f]$/u.test(source[index + 2] ?? '')) {
        index += 1;
        digits += source[index + 1]!;
      }
      if (digits.length > 0) {
        result += escapeAwkRegexLiteralCharacter({
          character: String.fromCharCode(Number.parseInt(digits, 16)),
        });
        index += 1;
        continue;
      }
    }

    if (/[0-9A-Za-z]/u.test(escaped)) {
      result += escapeAwkRegexLiteralCharacter({ character: escaped });
    } else if (escaped === '/') {
      result += '/';
    } else {
      result += `${character}${escaped}`;
    }
    index += 1;
  }
  return result;
}

type PreviousTokenKind = 'start' | 'open-group' | 'alternation' | 'operand';

function validateAwkRegularExpression({ source }: { source: string }): void {
  let previous: PreviousTokenKind = 'start';
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      if (index + 1 < source.length) index += 1;
      previous = 'operand';
      continue;
    }
    if (inBracket) {
      if (character === ']') {
        inBracket = false;
        previous = 'operand';
      }
      continue;
    }
    if (character === '[') {
      inBracket = true;
      continue;
    }

    switch (character) {
    case '(':
      previous = 'open-group';
      break;
    case '|':
      switch (previous) {
      case 'operand':
        break;
      case 'start':
      case 'open-group':
      case 'alternation':
        throw new Error(`regular expression compile failed (missing operand)\n${source}`);
      default: {
        const _ex: never = previous;
        throw new Error(`Unhandled previous AWK regular expression token: ${_ex}`);
      }
      }
      previous = 'alternation';
      break;
    case ')':
      switch (previous) {
      case 'operand':
        break;
      case 'start':
      case 'open-group':
      case 'alternation':
        throw new Error(`regular expression compile failed (missing operand)\n${source}`);
      default: {
        const _ex: never = previous;
        throw new Error(`Unhandled previous AWK regular expression token: ${_ex}`);
      }
      }
      previous = 'operand';
      break;
    case '*':
    case '+':
    case '?':
      break;
    default:
      previous = 'operand';
      break;
    }
  }

  switch (previous) {
  case 'alternation':
    throw new Error(`regular expression compile failed (missing operand)\n${source}`);
  case 'start':
  case 'open-group':
  case 'operand':
    break;
  default: {
    const _ex: never = previous;
    throw new Error(`Unhandled final AWK regular expression token: ${_ex}`);
  }
  }
}

export function compileAwkRegularExpression({
  source,
  flags,
}: {
  source: string,
  flags: string,
}): RegExp {
  validateAwkRegularExpression({ source });
  return compilePosixCompatibleRegExp({
    source: normalizeAwkDynamicRegexEscapes({ source }),
    flags: flags.includes('s') ? flags : `${flags}s`,
    characterClassMode: 'ascii',
  });
}

export const TEST_ONLY = {
  validateAwkRegularExpression,
};
