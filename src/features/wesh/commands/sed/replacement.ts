import { findPosixLeftmostLongestMatch } from '@/features/wesh/commands/_shared/posix-regexp';
import {
  foldAsciiCase,
  uppercaseAscii,
  type WeshCharacterLocaleMode,
} from '@/features/wesh/commands/_shared/locale';
import {
  decodeCommandDataBytes,
  encodeCommandDataText,
} from '@/features/wesh/commands/_shared/data-codec';
import { decodeSedExtendedEscape } from './escape';
import { toSedLocaleText } from './locale-text';

export function maximumSedReplacementBackreference({
  replacement,
}: {
  replacement: string;
}): number {
  let maximum = 0;
  for (let index = 0; index < replacement.length; index += 1) {
    if (replacement[index] !== "\\") continue;
    const escaped = replacement[index + 1];
    if (escaped === undefined) break;
    if (/^[1-9]$/.test(escaped)) {
      maximum = Math.max(maximum, Number.parseInt(escaped, 10));
    }
    index += 1;
  }
  return maximum;
}

type SedReplacementCaseMode = 'none' | 'lower' | 'upper';

function resolveSedSingleCharacterUppercase({
  character,
}: {
  character: string;
}): string | undefined {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return undefined;

  if (
    (codePoint >= 0x1f80 && codePoint <= 0x1f87)
    || (codePoint >= 0x1f90 && codePoint <= 0x1f97)
    || (codePoint >= 0x1fa0 && codePoint <= 0x1fa7)
  ) {
    return String.fromCodePoint(codePoint + 0x08);
  }

  switch (codePoint) {
  case 0x1fb3:
    return 'ᾼ';
  case 0x1fc3:
    return 'ῌ';
  case 0x1ff3:
    return 'ῼ';
  default:
    return undefined;
  }
}

function applySedCharacterCase({
  character,
  mode,
  characterLocaleMode,
}: {
  character: string;
  mode: Exclude<SedReplacementCaseMode, 'none'>;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case 'ascii': {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit >= 0x80 && codeUnit < 0xff) {
      // GNU sed's C-locale replacement case conversion maps non-ASCII
      // single bytes below 0xff to 0xff for both upper and lower modes.
      return '\xff';
    }
    switch (mode) {
    case 'lower':
      return foldAsciiCase({ value: character });
    case 'upper':
      return uppercaseAscii({ value: character });
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled replacement case mode: ${_ex}`);
    }
    }
  }
  case 'unicode': {
    const converted = (() => {
      switch (mode) {
      case 'lower':
        return character.toLowerCase();
      case 'upper':
        return character.toUpperCase();
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled replacement case mode: ${_ex}`);
      }
      }
    })();
    const convertedCharacters = [...converted];
    if (convertedCharacters.length === 1) return convertedCharacters[0]!;

    // JavaScript exposes full Unicode case mappings, while GNU sed applies
    // a single-character locale mapping. Preserve sed's one-code-point
    // result instead of accepting JavaScript's multi-code-point expansion.
    switch (mode) {
    case 'lower':
      if (character === 'İ') return 'i';
      return character;
    case 'upper':
      return resolveSedSingleCharacterUppercase({ character }) ?? character;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled replacement case mode: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled character locale mode: ${_ex}`);
  }
  }
}

function applySedReplacement({
  replacement,
  match,
  captures,
  characterLocaleMode,
}: {
  replacement: string;
  match: string;
  captures: readonly (string | undefined)[];
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  let output = '';
  let persistentMode: SedReplacementCaseMode = 'none';
  let nextMode: Exclude<SedReplacementCaseMode, 'none'> | undefined;

  const append = ({ value }: { value: string }): void => {
    for (const character of value) {
      const mode = nextMode ?? persistentMode;
      nextMode = undefined;
      switch (mode) {
      case 'none':
        output += character;
        break;
      case 'lower':
      case 'upper':
        output += applySedCharacterCase({
          character,
          mode,
          characterLocaleMode,
        });
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled replacement case mode: ${_ex}`);
      }
      }
    }
  };

  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index]!;
    if (character === '&') {
      append({ value: match });
      continue;
    }
    if (character !== '\\') {
      const codePoint = replacement.codePointAt(index);
      const literal = codePoint === undefined ? character : String.fromCodePoint(codePoint);
      append({ value: toSedLocaleText({ text: literal, characterLocaleMode }) });
      if (literal.length === 2) index += 1;
      continue;
    }

    const next = replacement[index + 1];
    if (next === undefined) {
      append({ value: '\\' });
      continue;
    }
    if (next === '0') {
      append({ value: match });
      index += 1;
      continue;
    }
    if (/^[1-9]$/.test(next)) {
      append({ value: captures[Number.parseInt(next, 10) - 1] ?? '' });
      index += 1;
      continue;
    }
    if (next === '&' || next === '\\') {
      append({ value: next });
      index += 1;
      continue;
    }
    const decoded = decodeSedExtendedEscape({
      source: replacement,
      backslashIndex: index,
    });
    if (decoded !== undefined) {
      append({
        value: toSedLocaleText({
          text: decoded.value,
          characterLocaleMode,
        }),
      });
      index = decoded.lastIndex;
      continue;
    }
    if (next === 'c') {
      // GNU sed preserves the backslash for an incomplete replacement \c.
      append({ value: '\\' });
      index += 1;
      continue;
    }
    switch (next) {
    case 'L':
      persistentMode = 'lower';
      nextMode = undefined;
      break;
    case 'U':
      persistentMode = 'upper';
      nextMode = undefined;
      break;
    case 'E':
      persistentMode = 'none';
      nextMode = undefined;
      break;
    case 'l':
      nextMode = 'lower';
      break;
    case 'u':
      nextMode = 'upper';
      break;
    default:
      append({ value: next });
      break;
    }
    index += 1;
  }
  return output;
}

export function substituteSedPattern({
  source,
  regex,
  replacement,
  occurrence,
  replaceFollowing,
  characterLocaleMode,
}: {
  source: string;
  regex: RegExp;
  replacement: string;
  occurrence: number;
  replaceFollowing: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
}): { text: string; matched: boolean } {
  const searchRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
  );
  const interiorByteEmptyMatch = (() => {
    if (characterLocaleMode !== 'unicode' || regex.source.includes('\\p{')) return undefined;
    const result = findPosixLeftmostLongestMatch({
      regex: searchRegex,
      source: '!!',
      startIndex: 1,
    });
    return result?.index === 1 && result.text.length === 0 ? result : undefined;
  })();
  let cursor = 0;
  let searchIndex = 0;
  let previousNonEmptyMatchEnd = -1;
  let text = '';
  let matchNumber = 0;
  let replacedAny = false;

  const appendReplacement = ({ captures }: { captures: readonly (string | undefined)[] }): boolean => {
    matchNumber += 1;
    const shouldReplace =
      matchNumber === occurrence
      || (replaceFollowing && matchNumber > occurrence);
    if (!shouldReplace) return false;
    text += applySedReplacement({
      replacement,
      match: '',
      captures,
      characterLocaleMode,
    });
    replacedAny = true;
    return true;
  };

  const consumeAfterEmptyMatch = ({ start }: { start: number }): { nextIndex: number; completed: boolean } => {
    const codePoint = source.codePointAt(start);
    const nextIndex = start + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
    const bytes = encodeCommandDataText({ text: source.slice(start, nextIndex) });
    if (bytes.byteLength <= 1 || interiorByteEmptyMatch === undefined) {
      text += source.slice(start, nextIndex);
      return { nextIndex, completed: false };
    }

    text += decodeCommandDataBytes({ bytes: bytes.subarray(0, 1) });
    for (let byteIndex = 1; byteIndex < bytes.byteLength; byteIndex += 1) {
      const replaced = appendReplacement({ captures: interiorByteEmptyMatch.captures });
      if (replaced && !replaceFollowing) {
        text += decodeCommandDataBytes({ bytes: bytes.subarray(byteIndex) });
        text += source.slice(nextIndex);
        return { nextIndex: source.length, completed: true };
      }
      text += decodeCommandDataBytes({ bytes: bytes.subarray(byteIndex, byteIndex + 1) });
    }
    return { nextIndex, completed: false };
  };

  while (searchIndex <= source.length) {
    const result = findPosixLeftmostLongestMatch({
      regex: searchRegex,
      source,
      startIndex: searchIndex,
    });
    if (result === undefined) break;

    const match = result.text;
    const start = result.index;
    const end = start + match.length;
    if (match.length === 0 && start === previousNonEmptyMatchEnd) {
      if (start >= source.length) break;
      const consumed = consumeAfterEmptyMatch({ start });
      if (consumed.completed) return { text, matched: true };
      cursor = consumed.nextIndex;
      searchIndex = consumed.nextIndex;
      previousNonEmptyMatchEnd = -1;
      continue;
    }

    text += source.slice(cursor, start);
    if (match.length === 0) {
      const replaced = appendReplacement({ captures: result.captures });
      if (replaced && !replaceFollowing) {
        text += source.slice(start);
        return { text, matched: true };
      }
      if (start >= source.length) {
        cursor = start;
        break;
      }
      const consumed = consumeAfterEmptyMatch({ start });
      if (consumed.completed) return { text, matched: true };
      cursor = consumed.nextIndex;
      searchIndex = consumed.nextIndex;
      previousNonEmptyMatchEnd = -1;
      continue;
    }

    matchNumber += 1;
    const shouldReplace =
      matchNumber === occurrence
      || (replaceFollowing && matchNumber > occurrence);
    text += shouldReplace
      ? applySedReplacement({
        replacement,
        match,
        captures: result.captures,
        characterLocaleMode,
      })
      : match;
    replacedAny ||= shouldReplace;
    cursor = end;
    searchIndex = end;
    previousNonEmptyMatchEnd = end;

    if (replacedAny && !replaceFollowing) {
      text += source.slice(cursor);
      return { text, matched: true };
    }
  }

  text += source.slice(cursor);
  return { text, matched: replacedAny };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
