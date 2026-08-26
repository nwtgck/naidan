const REGEXP_SPECIAL_CHARACTERS = /[\\^$.*+?()[\]{}|]/gu;

function getPosixCharacterClassSource({ name }: { name: string }): string | undefined {
  switch (name) {
  case 'alnum': return 'A-Za-z0-9';
  case 'alpha': return 'A-Za-z';
  case 'blank': return ' \\t';
  case 'cntrl': return '\\x00-\\x1F\\x7F';
  case 'digit': return '0-9';
  case 'graph': return '\\x21-\\x7E';
  case 'lower': return 'a-z';
  case 'print': return '\\x20-\\x7E';
  case 'punct': return '!-/:-@\\[-`{-~';
  case 'space': return ' \\t\\r\\n\\v\\f';
  case 'upper': return 'A-Z';
  case 'xdigit': return 'A-Fa-f0-9';
  default: return undefined;
  }
}

function escapeRegExpCharacter({ value }: { value: string }): string {
  return value.replace(REGEXP_SPECIAL_CHARACTERS, '\\$&');
}

function parseCharacterClass({
  pattern,
  start,
  allowBangNegation,
}: {
  pattern: string,
  start: number,
  allowBangNegation: boolean,
}): { source: string, end: number } | undefined {
  let index = start + 1;
  let source = '[';
  if (pattern[index] === '^' || (allowBangNegation && pattern[index] === '!')) {
    source += '^';
    index++;
  }
  if (pattern[index] === ']') {
    source += '\\]';
    index++;
  }

  let hasContent = false;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === ']' && hasContent) {
      return { source: `${source}]`, end: index };
    }
    if (character === '[' && pattern[index + 1] === ':') {
      const classEnd = pattern.indexOf(':]', index + 2);
      if (classEnd >= 0) {
        const className = pattern.slice(index + 2, classEnd);
        const classSource = getPosixCharacterClassSource({ name: className });
        if (classSource !== undefined) {
          source += classSource;
          index = classEnd + 2;
          hasContent = true;
          continue;
        }
      }
    }
    if (character === '\\' && index + 1 < pattern.length) {
      source += escapeRegExpCharacter({ value: pattern[index + 1]! });
      index += 2;
      hasContent = true;
      continue;
    }
    if (character === '^') source += '\\^';
    else if (character === ']') source += '\\]';
    else source += character;
    index++;
    hasContent = true;
  }
  return undefined;
}

function convertBasicRegularExpression({ pattern }: { pattern: string }): string {
  let result = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === '[') {
      const characterClass = parseCharacterClass({
        pattern,
        start: index,
        allowBangNegation: false,
      });
      if (characterClass === undefined) {
        result += character;
        index++;
      } else {
        result += characterClass.source;
        index = characterClass.end + 1;
      }
      continue;
    }
    if (character === '\\' && index + 1 < pattern.length) {
      const next = pattern[index + 1]!;
      switch (next) {
      case '|':
      case '(':
      case ')':
      case '{':
      case '}':
      case '+':
      case '?':
        result += next;
        index += 2;
        continue;
      default:
        result += character + next;
        index += 2;
        continue;
      }
    }
    if ('+?|(){}'.includes(character)) result += `\\${character}`;
    else result += character;
    index++;
  }
  return result;
}

export function compileBasicRegularExpression({ pattern }: { pattern: string }): RegExp {
  return new RegExp(convertBasicRegularExpression({ pattern }));
}

export function compileFileNameGlob({
  pattern,
  ignoreCase,
}: {
  pattern: string,
  ignoreCase: boolean,
}): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    switch (character) {
    case '*':
      source += '.*';
      break;
    case '?':
      source += '.';
      break;
    case '[': {
      const characterClass = parseCharacterClass({
        pattern,
        start: index,
        allowBangNegation: true,
      });
      if (characterClass === undefined) {
        source += '\\[';
      } else {
        source += characterClass.source;
        index = characterClass.end;
      }
      break;
    }
    case '\\':
      if (index + 1 < pattern.length) {
        source += escapeRegExpCharacter({ value: pattern[++index]! });
      } else {
        source += '\\\\';
      }
      break;
    default:
      source += escapeRegExpCharacter({ value: character });
      break;
    }
  }
  source += '$';
  return new RegExp(source, ignoreCase ? 'i' : undefined);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
