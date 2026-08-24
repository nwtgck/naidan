import { exceedsSafeRegularExpressionInputLimit } from '@/features/wesh/commands/_shared/backtracking-safety';

const POSIX_CHARACTER_CLASS_SOURCES = {
  alnum: String.raw`\p{L}\p{N}`,
  alpha: String.raw`\p{L}`,
  blank: String.raw` \t`,
  cntrl: String.raw`\x00-\x1f\x7f`,
  digit: '0-9',
  graph: String.raw`\p{L}\p{N}\p{P}\p{S}`,
  lower: String.raw`\p{Ll}`,
  print: String.raw`\p{L}\p{N}\p{P}\p{S} `,
  punct: String.raw`\p{P}\p{S}`,
  space: String.raw`\s`,
  upper: String.raw`\p{Lu}`,
  word: String.raw`\p{L}\p{N}\p{M}_`,
  xdigit: '0-9A-Fa-f',
} as const;

const POSIX_ASCII_CHARACTER_CLASS_SOURCES = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  blank: String.raw` \t`,
  cntrl: String.raw`\x00-\x1f\x7f`,
  digit: '0-9',
  graph: String.raw`\x21-\x7e`,
  lower: 'a-z',
  print: String.raw`\x20-\x7e`,
  punct: '!-/:-@\\[-\\x60{-~',
  space: String.raw`\s`,
  upper: 'A-Z',
  word: 'A-Za-z0-9_',
  xdigit: '0-9A-Fa-f',
} as const satisfies Record<keyof typeof POSIX_CHARACTER_CLASS_SOURCES, string>;

const UNICODE_WORD_CHARACTER_SOURCE = String.raw`\p{L}\p{N}\p{M}_`;

type PosixCharacterClassName = keyof typeof POSIX_CHARACTER_CLASS_SOURCES;
type PosixCharacterClassMode = 'unicode' | 'ascii';
type PosixRegularExpressionSyntax = 'basic' | 'extended';
type PosixBasicOperatorMode = 'gnu' | 'minimal';
type PosixDotMode = 'javascript' | 'non-newline' | 'non-null';
const SURROGATE_ESCAPE_CLASS = String.raw`\udc80-\udcff`;
type PosixBracketSubexpressionMarker = ':' | '.' | '=';

function consumeBracketSubexpression({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { marker: PosixBracketSubexpressionMarker, content: string, endIndex: number } | undefined {
  if (source[startIndex] !== '[') return undefined;
  const marker = source[startIndex + 1];
  if (marker !== ':' && marker !== '.' && marker !== '=') return undefined;
  const closing = `${marker}]`;
  const contentEnd = source.indexOf(closing, startIndex + 2);
  if (contentEnd < 0) return undefined;
  return {
    marker,
    content: source.slice(startIndex + 2, contentEnd),
    endIndex: contentEnd + 1,
  };
}

function escapeBracketLiteral({ value }: { value: string }): string {
  return value.replace(/[\\\]^-]/gu, '\\$&');
}

function escapeRegularExpressionLiteral({ value }: { value: string }): string {
  return `[${escapeBracketLiteral({ value })}]`;
}

function consumeBracketExpression({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { source: string, endIndex: number } | undefined {
  let index = startIndex + 1;
  if (source[index] === '^') index += 1;
  if (source[index] === ']') index += 1;

  while (index < source.length) {
    const subexpression = consumeBracketSubexpression({ source, startIndex: index });
    if (subexpression !== undefined) {
      index = subexpression.endIndex + 1;
      continue;
    }
    if (source[index] === '\\' && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (source[index] === ']') {
      return {
        source: source.slice(startIndex, index + 1),
        endIndex: index,
      };
    }
    index += 1;
  }

  return undefined;
}

function normalizePosixBracketEscapes({ source }: { source: string }): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== '\\' || index + 1 >= source.length - 1) {
      result += character;
      continue;
    }
    const escaped = source[index + 1]!;
    if (/[0-9A-Za-z]/u.test(escaped)) {
      result += escapeBracketLiteral({ value: escaped });
    } else {
      result += `${character}${escaped}`;
    }
    index += 1;
  }
  return result;
}

function normalizePosixBracketEscapesInSource({ source }: { source: string }): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '[') {
      result += source[index];
      continue;
    }
    const bracket = consumeBracketExpression({ source, startIndex: index });
    if (bracket === undefined) {
      result += source[index];
      continue;
    }
    result += normalizePosixBracketEscapes({ source: bracket.source });
    index = bracket.endIndex;
  }
  return result;
}

function translateBracketExpression({
  source,
  characterClassMode,
  translatePosixClasses,
}: {
  source: string,
  characterClassMode: PosixCharacterClassMode,
  translatePosixClasses: boolean,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  const characterClasses = (() => {
    switch (characterClassMode) {
    case 'unicode':
      return POSIX_CHARACTER_CLASS_SOURCES;
    case 'ascii':
      return POSIX_ASCII_CHARACTER_CLASS_SOURCES;
    default: {
      const _ex: never = characterClassMode;
      throw new Error(`Unhandled POSIX character class mode: ${_ex}`);
    }
    }
  })();
  let requiresUnicode = false;
  let result = '[';
  let index = 1;
  const contentEnd = source.length - 1;

  if (source[index] === '^') {
    result += '^';
    index += 1;
  }
  if (source[index] === ']') {
    result += String.raw`\]`;
    index += 1;
  }

  while (index < contentEnd) {
    const subexpression = consumeBracketSubexpression({ source, startIndex: index });
    if (subexpression !== undefined && subexpression.endIndex < contentEnd) {
      switch (subexpression.marker) {
      case ':': {
        if (!translatePosixClasses) break;
        const rawName = subexpression.content;
        const name = rawName.toLowerCase() as PosixCharacterClassName;
        const replacement = characterClasses[name];
        if (replacement === undefined) {
          throw new Error(`Invalid character class name '${rawName}'`);
        }
        result += replacement;
        requiresUnicode ||= replacement.includes(String.raw`\p{`);
        index = subexpression.endIndex + 1;
        continue;
      }
      case '.':
      case '=': {
        const symbols = Array.from(subexpression.content);
        if (symbols.length !== 1) {
          throw new Error(`Unsupported multi-character collating element '${subexpression.content}'`);
        }
        const symbol = symbols[0]!;
        result += escapeBracketLiteral({ value: symbol });
        requiresUnicode ||= symbol.length > 1;
        index = subexpression.endIndex + 1;
        continue;
      }
      default: {
        const _ex: never = subexpression.marker;
        throw new Error(`Unhandled POSIX bracket subexpression marker: ${_ex}`);
      }
      }
    }

    result += source[index];
    index += 1;
  }

  result += ']';
  return { source: result, requiresUnicode };
}

function translateBracketExpressions({
  source,
  characterClassMode,
  translatePosixClasses,
}: {
  source: string,
  characterClassMode: PosixCharacterClassMode,
  translatePosixClasses: boolean,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  let result = '';
  let requiresUnicode = false;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '[') {
      result += source[index];
      continue;
    }

    const bracket = consumeBracketExpression({ source, startIndex: index });
    if (bracket === undefined) {
      result += source[index];
      continue;
    }

    const translated = translateBracketExpression({
      source: bracket.source,
      characterClassMode,
      translatePosixClasses,
    });
    result += translated.source;
    requiresUnicode ||= translated.requiresUnicode;
    index = bracket.endIndex;
  }

  return { source: result, requiresUnicode };
}

export function translatePosixCharacterClasses({
  source,
  characterClassMode,
}: {
  source: string,
  characterClassMode: PosixCharacterClassMode,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  return translateBracketExpressions({
    source,
    characterClassMode,
    translatePosixClasses: true,
  });
}

function convertGnuWordOperator({
  operator,
  characterClassMode,
}: {
  operator: string,
  characterClassMode: PosixCharacterClassMode,
}): { source: string, requiresUnicode: boolean } | undefined {
  let wordSource: string;
  let requiresUnicode: boolean;
  switch (characterClassMode) {
  case 'ascii':
    wordSource = POSIX_ASCII_CHARACTER_CLASS_SOURCES.word;
    requiresUnicode = false;
    break;
  case 'unicode':
    wordSource = UNICODE_WORD_CHARACTER_SOURCE;
    requiresUnicode = true;
    break;
  default:
    throw new Error(`Unhandled POSIX character class mode: ${characterClassMode satisfies never}`);
  }
  const word = `[${wordSource}]`;
  switch (operator) {
  case 'w':
    return { source: word, requiresUnicode };
  case 'W':
    return { source: `[^${wordSource}]`, requiresUnicode };
  case '<':
    return { source: `(?<!${word})(?=${word})`, requiresUnicode };
  case '>':
    return { source: `(?<=${word})(?!${word})`, requiresUnicode };
  case 'b':
    return {
      source: `(?:(?<!${word})(?=${word})|(?<=${word})(?!${word}))`,
      requiresUnicode,
    };
  case 'B':
    return {
      source: `(?:(?<=${word})(?=${word})|(?<!${word})(?!${word}))`,
      requiresUnicode,
    };
  case 's':
    return { source: String.raw`\s`, requiresUnicode: false };
  case 'S':
    return { source: String.raw`\S`, requiresUnicode: false };
  default:
    return undefined;
  }
}

function validatePosixBackreferences({
  source,
  syntax,
}: {
  source: string,
  syntax: PosixRegularExpressionSyntax,
}): void {
  let captureGroupCount = 0;
  const references: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '[') {
      const bracket = consumeBracketExpression({ source, startIndex: index });
      if (bracket !== undefined) {
        index = bracket.endIndex;
        continue;
      }
    }

    if (source[index] === '\\') {
      const next = source[index + 1];
      if (next === undefined) continue;
      if (/^[1-9]$/u.test(next)) references.push(Number(next));
      if (syntax === 'basic' && next === '(') captureGroupCount += 1;
      index += 1;
      continue;
    }

    if (syntax === 'extended' && source[index] === '(') {
      captureGroupCount += 1;
    }
  }

  if (references.some((reference) => reference > captureGroupCount)) {
    throw new Error('Invalid back reference');
  }
}


function consumeJavaScriptRegexEscape({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): number {
  const escaped = source[startIndex + 1];
  if (escaped === undefined) return startIndex + 1;
  if (
    (escaped === 'p' || escaped === 'P' || escaped === 'u' || escaped === 'x')
    && source[startIndex + 2] === '{'
  ) {
    const closingBrace = source.indexOf('}', startIndex + 3);
    if (closingBrace >= 0) return closingBrace + 1;
  }
  if (escaped === 'k' && source[startIndex + 2] === '<') {
    const closingAngle = source.indexOf('>', startIndex + 3);
    if (closingAngle >= 0) return closingAngle + 1;
  }
  return startIndex + 2;
}

function consumeJavaScriptRegexClass({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): number {
  let index = startIndex + 1;
  if (source[index] === '^') index += 1;
  if (source[index] === ']') index += 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index = consumeJavaScriptRegexEscape({ source, startIndex: index });
      continue;
    }
    if (source[index] === ']') return index + 1;
    index += 1;
  }
  return source.length;
}

function consumeJavaScriptRegexQuantifier({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { endIndex: number, text: string } | undefined {
  const character = source[startIndex];
  if (character === '*' || character === '+' || character === '?') {
    return { endIndex: startIndex + 1, text: character };
  }
  if (character !== '{') return undefined;
  const match = /^\{\d+(?:,\d*)?\}/u.exec(source.slice(startIndex));
  if (match === null) return undefined;
  return {
    endIndex: startIndex + match[0].length,
    text: match[0],
  };
}

function consumeJavaScriptRegexGroupPrefix({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { bodyStartIndex: number, prefix: string } {
  if (source[startIndex + 1] !== '?') {
    return { bodyStartIndex: startIndex + 1, prefix: '(' };
  }
  for (const prefix of ['(?:', '(?=', '(?!', '(?<=', '(?<!'] as const) {
    if (source.startsWith(prefix, startIndex)) {
      return {
        bodyStartIndex: startIndex + prefix.length,
        prefix,
      };
    }
  }
  if (source.startsWith('(?<', startIndex)) {
    const closingAngle = source.indexOf('>', startIndex + 3);
    if (closingAngle >= 0) {
      return {
        bodyStartIndex: closingAngle + 1,
        prefix: source.slice(startIndex, closingAngle + 1),
      };
    }
  }
  return { bodyStartIndex: startIndex + 1, prefix: '(' };
}

function normalizeRepeatedJavaScriptRegexQuantifiers({
  source,
}: {
  source: string,
}): string {
  type RegexRope = string | readonly RegexRope[];
  type SegmentFrame = {
    index: number,
    readonly stopAtClosingParenthesis: boolean,
    readonly parts: RegexRope[],
    readonly continuation: {
      readonly groupStartIndex: number,
      readonly prefix: string,
    } | undefined,
  };

  const appendQuantifiedAtom = ({
    frame,
    atom,
    nextIndex,
  }: {
    frame: SegmentFrame,
    atom: RegexRope,
    nextIndex: number,
  }): void => {
    let quantifiedAtom = atom;
    let quantifierCount = 0;
    let index = nextIndex;
    while (index < source.length) {
      const quantifier = consumeJavaScriptRegexQuantifier({ source, startIndex: index });
      if (quantifier === undefined) break;
      quantifiedAtom = quantifierCount === 0
        ? [quantifiedAtom, quantifier.text]
        : ['(?:', quantifiedAtom, ')', quantifier.text];
      quantifierCount += 1;
      index = quantifier.endIndex;
    }
    frame.parts.push(quantifiedAtom);
    frame.index = index;
  };

  const frames: SegmentFrame[] = [{
    index: 0,
    stopAtClosingParenthesis: false,
    parts: [],
    continuation: undefined,
  }];
  let root: RegexRope | undefined;

  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const character = source[frame.index];
    if (character === undefined || (character === ')' && frame.stopAtClosingParenthesis)) {
      switch (character) {
      case ')':
        frame.index += 1;
        break;
      case undefined:
        break;
      default: {
        const _ex: never = character;
        throw new Error(`Unhandled regular-expression segment end: ${_ex}`);
      }
      }
      frames.pop();

      const completed: RegexRope = frame.parts;
      const continuation = frame.continuation;
      if (continuation === undefined) {
        root = completed;
        break;
      }

      const parent = frames.at(-1);
      if (parent === undefined) {
        throw new Error('regular-expression normalization parent frame is missing');
      }
      const completedWithClosingParenthesis = frame.index <= source.length
        && source[frame.index - 1] === ')';
      appendQuantifiedAtom({
        frame: parent,
        atom: completedWithClosingParenthesis
          ? [continuation.prefix, completed, ')']
          : source.slice(continuation.groupStartIndex),
        nextIndex: completedWithClosingParenthesis ? frame.index : source.length,
      });
      continue;
    }

    if (character === '|' || character === '^' || character === '$') {
      frame.parts.push(character);
      frame.index += 1;
      continue;
    }
    if (character === '*' || character === '+' || character === '?' || character === '{') {
      frame.parts.push(character);
      frame.index += 1;
      continue;
    }

    if (character === '\\') {
      const atomEndIndex = consumeJavaScriptRegexEscape({ source, startIndex: frame.index });
      appendQuantifiedAtom({
        frame,
        atom: source.slice(frame.index, atomEndIndex),
        nextIndex: atomEndIndex,
      });
      continue;
    }
    if (character === '[') {
      const atomEndIndex = consumeJavaScriptRegexClass({ source, startIndex: frame.index });
      appendQuantifiedAtom({
        frame,
        atom: source.slice(frame.index, atomEndIndex),
        nextIndex: atomEndIndex,
      });
      continue;
    }
    if (character === '(') {
      const groupStartIndex = frame.index;
      const group = consumeJavaScriptRegexGroupPrefix({ source, startIndex: groupStartIndex });
      frames.push({
        index: group.bodyStartIndex,
        stopAtClosingParenthesis: true,
        parts: [],
        continuation: { groupStartIndex, prefix: group.prefix },
      });
      continue;
    }

    appendQuantifiedAtom({
      frame,
      atom: character,
      nextIndex: frame.index + 1,
    });
  }

  if (root === undefined) {
    throw new Error('regular-expression normalization did not produce output');
  }
  const flattened: string[] = [];
  const pending: RegexRope[] = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current === 'string') {
      flattened.push(current);
      continue;
    }
    for (let index = current.length - 1; index >= 0; index -= 1) {
      pending.push(current[index]!);
    }
  }
  return flattened.join('');
}

function translatePosixRegularExpression({
  source,
  syntax,
  characterClassMode,
  gnuWordOperators,
  basicOperatorMode,
  dotMode,
  excludeSurrogateEscapes,
}: {
  source: string,
  syntax: PosixRegularExpressionSyntax,
  characterClassMode: PosixCharacterClassMode,
  gnuWordOperators: boolean,
  basicOperatorMode: PosixBasicOperatorMode | undefined,
  dotMode: PosixDotMode,
  excludeSurrogateEscapes: boolean,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  validatePosixBackreferences({ source, syntax });

  let result = '';
  let requiresUnicode = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (character === '[') {
      const bracket = consumeBracketExpression({ source, startIndex: index });
      if (bracket === undefined) {
        result += character;
      } else {
        const normalizedBracket = normalizePosixBracketEscapes({ source: bracket.source });
        result += excludeSurrogateEscapes
          ? `(?![${SURROGATE_ESCAPE_CLASS}])${normalizedBracket}`
          : normalizedBracket;
        index = bracket.endIndex;
      }
      continue;
    }

    if (character === '\\') {
      const next = source[index + 1];
      if (next === undefined) {
        result += '\\';
        continue;
      }

      if (gnuWordOperators) {
        const wordOperator = convertGnuWordOperator({ operator: next, characterClassMode });
        if (wordOperator !== undefined) {
          const consumesCharacter = next === 'w' || next === 'W' || next === 's' || next === 'S';
          result += excludeSurrogateEscapes && consumesCharacter
            ? `(?![${SURROGATE_ESCAPE_CLASS}])${wordOperator.source}`
            : wordOperator.source;
          requiresUnicode ||= wordOperator.requiresUnicode;
          index += 1;
          continue;
        }
      }

      if (/[0-9A-Za-z]/u.test(next) && !/^[1-9]$/u.test(next)) {
        result += escapeRegularExpressionLiteral({ value: next });
        index += 1;
        continue;
      }

      switch (syntax) {
      case 'basic': {
        const escapedOperators = (() => {
          switch (basicOperatorMode) {
          case 'gnu':
            return '|()+?{}';
          case 'minimal':
            return '(){}';
          case undefined:
            throw new Error('POSIX basic regular expression requires an operator mode');
          default: {
            const _ex: never = basicOperatorMode;
            throw new Error(`Unhandled POSIX basic operator mode: ${_ex}`);
          }
          }
        })();
        if (escapedOperators.includes(next)) {
          result += next;
        } else {
          result += `\\${next}`;
        }
        break;
      }
      case 'extended':
        result += `\\${next}`;
        break;
      default: {
        const _ex: never = syntax;
        throw new Error(`Unhandled POSIX regular expression syntax: ${_ex}`);
      }
      }
      index += 1;
      continue;
    }

    if (character === '.') {
      switch (dotMode) {
      case 'javascript':
        result += '.';
        break;
      case 'non-newline':
        result += excludeSurrogateEscapes
          ? `[^\n${SURROGATE_ESCAPE_CLASS}]`
          : String.raw`[^\n]`;
        break;
      case 'non-null':
        result += excludeSurrogateEscapes
          ? `[^\x00${SURROGATE_ESCAPE_CLASS}]`
          : String.raw`[^\x00]`;
        break;
      default: {
        const _ex: never = dotMode;
        throw new Error(`Unhandled POSIX dot mode: ${_ex}`);
      }
      }
      continue;
    }

    if (syntax === 'basic' && '|()+?{}'.includes(character)) {
      result += `\\${character}`;
      continue;
    }

    if (syntax === 'basic' && character === '^') {
      const startsBranch = index === 0 || (
        index >= 2
        && source[index - 2] === '\\'
        && (source[index - 1] === '(' || source[index - 1] === '|')
      );
      result += startsBranch ? '^' : String.raw`\^`;
      continue;
    }

    if (syntax === 'basic' && character === '$') {
      const endsBranch = index === source.length - 1 || (
        source[index + 1] === '\\'
        && (source[index + 2] === ')' || source[index + 2] === '|')
      );
      result += endsBranch ? '$' : String.raw`\$`;
      continue;
    }

    result += character;
  }

  const translatedClasses = translatePosixCharacterClasses({
    source: result,
    characterClassMode,
  });
  return {
    source: normalizeRepeatedJavaScriptRegexQuantifiers({
      source: translatedClasses.source,
    }),
    requiresUnicode: requiresUnicode || translatedClasses.requiresUnicode,
  };
}

export function translateBasicRegularExpression({
  source,
  characterClassMode,
  gnuWordOperators,
  basicOperatorMode,
  dotMode,
  excludeSurrogateEscapes,
}: {
  source: string,
  characterClassMode: PosixCharacterClassMode,
  gnuWordOperators: boolean,
  basicOperatorMode: PosixBasicOperatorMode,
  dotMode: PosixDotMode,
  excludeSurrogateEscapes: boolean,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  return translatePosixRegularExpression({
    source,
    syntax: 'basic',
    characterClassMode,
    gnuWordOperators,
    basicOperatorMode,
    dotMode,
    excludeSurrogateEscapes,
  });
}

export function translateExtendedRegularExpression({
  source,
  characterClassMode,
  gnuWordOperators,
  dotMode,
  excludeSurrogateEscapes,
}: {
  source: string,
  characterClassMode: PosixCharacterClassMode,
  gnuWordOperators: boolean,
  dotMode: PosixDotMode,
  excludeSurrogateEscapes: boolean,
}): {
  source: string,
  requiresUnicode: boolean,
} {
  return translatePosixRegularExpression({
    source,
    syntax: 'extended',
    characterClassMode,
    basicOperatorMode: undefined,
    gnuWordOperators,
    dotMode,
    excludeSurrogateEscapes,
  });
}

function compileTranslatedRegularExpression({
  translated,
  flags,
}: {
  translated: { source: string, requiresUnicode: boolean },
  flags: string,
}): RegExp {
  const resolvedFlags = translated.requiresUnicode && !flags.includes('u')
    ? `${flags}u`
    : flags;
  return new RegExp(translated.source, resolvedFlags || undefined);
}

export function compileBasicRegularExpression({
  source,
  flags,
  characterClassMode,
  gnuWordOperators,
  basicOperatorMode,
  dotMode,
  excludeSurrogateEscapes,
}: {
  source: string,
  flags: string,
  characterClassMode: PosixCharacterClassMode,
  gnuWordOperators: boolean,
  basicOperatorMode: PosixBasicOperatorMode,
  dotMode: PosixDotMode,
  excludeSurrogateEscapes: boolean,
}): RegExp {
  return compileTranslatedRegularExpression({
    translated: translateBasicRegularExpression({
      source,
      characterClassMode,
      gnuWordOperators,
      basicOperatorMode,
      dotMode,
      excludeSurrogateEscapes,
    }),
    flags,
  });
}

export function compileExtendedRegularExpression({
  source,
  flags,
  characterClassMode,
  gnuWordOperators,
  dotMode,
  excludeSurrogateEscapes,
}: {
  source: string,
  flags: string,
  characterClassMode: PosixCharacterClassMode,
  gnuWordOperators: boolean,
  dotMode: PosixDotMode,
  excludeSurrogateEscapes: boolean,
}): RegExp {
  return compileTranslatedRegularExpression({
    translated: translateExtendedRegularExpression({
      source,
      characterClassMode,
      gnuWordOperators,
      dotMode,
      excludeSurrogateEscapes,
    }),
    flags,
  });
}

export function compileEmacsRegularExpression({
  source,
  flags,
  matchWholeString,
}: {
  source: string,
  flags: string,
  matchWholeString: boolean,
}): RegExp {
  let result = '';
  let requiresUnicode = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '[') {
      const bracket = consumeBracketExpression({ source, startIndex: index });
      if (bracket === undefined) {
        result += character;
      } else {
        result += normalizePosixBracketEscapes({ source: bracket.source });
        index = bracket.endIndex;
      }
      continue;
    }

    if (character === '\\') {
      const next = source[index + 1];
      if (next === undefined) {
        result += '\\';
        continue;
      }
      const wordOperator = convertGnuWordOperator({
        operator: next,
        characterClassMode: 'ascii',
      });
      if (wordOperator !== undefined) {
        result += wordOperator.source;
        requiresUnicode ||= wordOperator.requiresUnicode;
      } else if ('()|'.includes(next)) {
        result += next;
      } else {
        result += `\\${next}`;
      }
      index += 1;
      continue;
    }

    if ('()|{}'.includes(character)) {
      result += `\\${character}`;
      continue;
    }
    result += character;
  }

  const normalizedBrackets = translateBracketExpressions({
    source: result,
    characterClassMode: 'ascii',
    translatePosixClasses: false,
  });
  const translated = {
    source: matchWholeString
      ? `^(?:${normalizedBrackets.source})$`
      : normalizedBrackets.source,
    requiresUnicode: requiresUnicode || normalizedBrackets.requiresUnicode,
  };
  return compileTranslatedRegularExpression({ translated, flags });
}

export function compilePosixCompatibleRegExp({
  source,
  flags,
  characterClassMode,
}: {
  source: string,
  flags: string,
  characterClassMode: PosixCharacterClassMode,
}): RegExp {
  const translated = translatePosixCharacterClasses({
    source: normalizePosixBracketEscapesInSource({ source }),
    characterClassMode,
  });
  return compileTranslatedRegularExpression({ translated, flags });
}

export interface PosixLeftmostLongestMatch {
  index: number,
  text: string,
  captures: readonly (string | undefined)[],
}

function withoutStatefulFlags({ flags }: { flags: string }): string {
  return flags.replace(/[gy]/g, '');
}

function containsBackreference({ source }: { source: string }): boolean {
  return /\\(?:[1-9]|k<)/.test(source);
}

function matchExactRange({
  regex,
  source,
  startIndex,
  endIndex,
  flags,
}: {
  regex: RegExp,
  source: string,
  startIndex: number,
  endIndex: number,
  flags: string,
}): RegExpExecArray | undefined {
  const remainingLength = source.length - endIndex;
  const exactRegex = new RegExp(
    String.raw`(?:${regex.source})(?=[\s\S]{${remainingLength}}(?![\s\S]))`,
    `${flags}y`,
  );
  exactRegex.lastIndex = startIndex;
  return exactRegex.exec(source) ?? undefined;
}

export interface PosixSplitPart {
  text: string,
  terminatedByMatch: boolean,
}

export function findPosixLeftmostLongestMatch({
  regex,
  source,
  startIndex,
}: {
  regex: RegExp,
  source: string,
  startIndex: number,
}): PosixLeftmostLongestMatch | undefined {
  if (exceedsSafeRegularExpressionInputLimit({ regex, input: source })) {
    throw new Error('regular expression input exceeds the safe backtracking limit');
  }
  const baseFlags = withoutStatefulFlags({ flags: regex.flags });
  const searchRegex = new RegExp(regex.source, `${baseFlags}g`);
  searchRegex.lastIndex = startIndex;
  const firstMatch = searchRegex.exec(source);
  if (firstMatch === null || firstMatch.index === undefined) return undefined;

  const leftmostIndex = firstMatch.index;
  const canUseGreedyFastPath = !regex.source.includes('|')
    && !/(?:[*+?]|\{[^}]*\})\?/u.test(regex.source);
  if (canUseGreedyFastPath) {
    return {
      index: leftmostIndex,
      text: firstMatch[0],
      captures: firstMatch.slice(1).map((value) => value === undefined ? undefined : String(value)),
    };
  }

  const candidateEnds = [leftmostIndex];
  for (let index = leftmostIndex; index < source.length;) {
    const codePoint = source.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    candidateEnds.push(index);
  }

  if (containsBackreference({ source: regex.source })) {
    for (let candidateIndex = candidateEnds.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const endIndex = candidateEnds[candidateIndex]!;
      const exactMatch = matchExactRange({
        regex,
        source,
        startIndex: leftmostIndex,
        endIndex,
        flags: baseFlags,
      });
      if (exactMatch === undefined) continue;

      return {
        index: leftmostIndex,
        text: source.slice(leftmostIndex, endIndex),
        captures: exactMatch.slice(1).map((value) => value === undefined ? undefined : String(value)),
      };
    }
    return undefined;
  }

  const exactEndRegex = new RegExp(
    String.raw`(?<=(?<![\s\S])[\s\S]{${leftmostIndex}}(?:${regex.source}))`,
    `${baseFlags}y`,
  );
  for (let candidateIndex = candidateEnds.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const endIndex = candidateEnds[candidateIndex]!;
    exactEndRegex.lastIndex = endIndex;
    const exactEndMatch = exactEndRegex.exec(source);
    if (exactEndMatch === null) continue;
    const exactMatch = matchExactRange({
      regex,
      source,
      startIndex: leftmostIndex,
      endIndex,
      flags: baseFlags,
    });
    if (exactMatch === undefined) continue;

    return {
      index: leftmostIndex,
      text: source.slice(leftmostIndex, endIndex),
      captures: exactMatch.slice(1).map((value) => value === undefined ? undefined : String(value)),
    };
  }

  return undefined;
}

export function splitByPosixLeftmostLongestMatches({
  regex,
  source,
}: {
  regex: RegExp,
  source: string,
}): readonly PosixSplitPart[] {
  const parts: PosixSplitPart[] = [];
  let cursor = 0;
  let searchIndex = 0;

  while (searchIndex <= source.length) {
    const match = findPosixLeftmostLongestMatch({ regex, source, startIndex: searchIndex });
    if (match === undefined) break;
    if (match.text.length === 0) {
      if (match.index >= source.length) break;
      const codePoint = source.codePointAt(match.index);
      searchIndex = match.index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
      continue;
    }

    parts.push({
      text: source.slice(cursor, match.index),
      terminatedByMatch: true,
    });
    cursor = match.index + match.text.length;
    searchIndex = cursor;
  }

  parts.push({
    text: source.slice(cursor),
    terminatedByMatch: false,
  });
  return parts;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  normalizeRepeatedJavaScriptRegexQuantifiers,
};
