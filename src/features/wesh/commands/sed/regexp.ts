import {
  compileBasicRegularExpression,
  compileExtendedRegularExpression,
} from '@/features/wesh/commands/_shared/posix-regexp';
import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { decodeCommandDataBytes } from '@/features/wesh/commands/_shared/data-codec';
import { decodeSedSingleCharacterEscape } from './escape';
import { isSingleByteSedDelimiter, toSedLocaleText } from './locale-text';

export type SedRegularExpressionSyntax = 'basic' | 'extended';

export interface SedRegexParseState {
  syntax: SedRegularExpressionSyntax;
  characterLocaleMode: WeshCharacterLocaleMode;
  nullData: boolean;
  sourceBoundaryIndices: ReadonlySet<number>;
  previousRegex: RegExp | undefined;
  previousCaptureCount: number;
}

function countSedCapturingGroups({
  source,
  syntax,
}: {
  source: string;
  syntax: SedRegularExpressionSyntax;
}): number {
  const normalized = normalizeSedRegularExpressionEscapes({ source });
  let count = 0;
  let inBracketExpression = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "[" && !inBracketExpression) {
      inBracketExpression = true;
      continue;
    }
    if (character === "]" && inBracketExpression) {
      inBracketExpression = false;
      continue;
    }
    if (character === "\\") {
      const escaped = normalized[index + 1];
      if (
        syntax === "basic" &&
        !inBracketExpression &&
        escaped === "("
      ) {
        count += 1;
      }
      if (escaped !== undefined) index += 1;
      continue;
    }
    if (
      syntax === "extended" &&
      !inBracketExpression &&
      character === "("
    ) {
      count += 1;
    }
  }
  return count;
}

function cloneSedRegex({
  regex,
  global,
}: {
  regex: RegExp;
  global: boolean;
}): RegExp {
  const flagsWithoutGlobal = regex.flags.replaceAll("g", "");
  const flags = global ? `${flagsWithoutGlobal}g` : flagsWithoutGlobal;
  return new RegExp(regex.source, flags || undefined);
}

function normalizeSedRegularExpressionEscapes({ source }: { source: string }): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== '\\' || index + 1 >= source.length) {
      result += character;
      continue;
    }

    const escaped = source[index + 1]!;
    const decoded = decodeSedSingleCharacterEscape({ escaped });
    if (decoded !== undefined) {
      result += decoded;
      index += 1;
      continue;
    }

    if (escaped === 'c') {
      const controlled = source[index + 2];
      if (controlled === undefined) throw new Error('Trailing backslash');
      const codePoint = controlled.codePointAt(0);
      if (codePoint === undefined) throw new Error('Trailing backslash');
      const normalizedCodePoint = codePoint >= 0x61 && codePoint <= 0x7a
        ? codePoint - 0x20
        : codePoint;
      const byte = normalizedCodePoint ^ 0x40;
      result += decodeCommandDataBytes({ bytes: Uint8Array.of(byte) });
      index += 2;
      continue;
    }

    if (escaped === 'x') {
      const match = /^[0-9A-Fa-f]{1,2}/u.exec(source.slice(index + 2));
      if (match !== null) {
        result += decodeCommandDataBytes({
          bytes: Uint8Array.of(Number.parseInt(match[0], 16) & 0xff),
        });
        index += 1 + match[0].length;
        continue;
      }
    }

    if (escaped === 'o') {
      const match = /^[0-7]{1,3}/u.exec(source.slice(index + 2));
      if (match !== null) {
        result += decodeCommandDataBytes({
          bytes: Uint8Array.of(Number.parseInt(match[0], 8) & 0xff),
        });
        index += 1 + match[0].length;
        continue;
      }
    }

    if (escaped === 'd') {
      const match = /^\d{1,3}/u.exec(source.slice(index + 2));
      if (match !== null) {
        result += decodeCommandDataBytes({
          bytes: Uint8Array.of(Number.parseInt(match[0], 10) & 0xff),
        });
        index += 1 + match[0].length;
        continue;
      }
    }

    result += `${character}${escaped}`;
    index += 1;
  }
  return result;
}

const SED_WILDCARD_DOT_SENTINEL = "\uD800";

function findSedPosixBracketSubexpressionEnd({
  source,
  index,
}: {
  source: string;
  index: number;
}): number | undefined {
  if (source[index] !== "[") return undefined;
  const marker = source[index + 1];
  if (marker !== ":" && marker !== "." && marker !== "=") return undefined;
  const closingIndex = source.indexOf(`${marker}]`, index + 2);
  if (closingIndex < 0) return undefined;
  const newlineIndex = source.indexOf("\n", index + 2);
  if (newlineIndex >= 0 && newlineIndex < closingIndex) return undefined;
  return closingIndex + 2;
}

function maskSedWildcardDots({ source }: { source: string }): string {
  let result = "";
  let inBracketExpression = false;
  let bracketCanClose = false;
  let bracketMayConsumeNegation = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      result += character;
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        result += escaped;
        index += 1;
      }
      if (inBracketExpression && !bracketCanClose) bracketCanClose = true;
      continue;
    }

    if (!inBracketExpression) {
      if (character === "[") {
        inBracketExpression = true;
        bracketCanClose = false;
        bracketMayConsumeNegation = true;
        result += character;
        continue;
      }
      result += character === "." ? SED_WILDCARD_DOT_SENTINEL : character;
      continue;
    }

    if (character === "[") {
      const bracketSubexpressionEnd = findSedPosixBracketSubexpressionEnd({
        source,
        index,
      });
      if (bracketSubexpressionEnd !== undefined) {
        result += source.slice(index, bracketSubexpressionEnd);
        index = bracketSubexpressionEnd - 1;
        bracketCanClose = true;
        bracketMayConsumeNegation = false;
        continue;
      }
    }

    result += character;
    if (character === "]") {
      if (bracketCanClose) {
        inBracketExpression = false;
        bracketMayConsumeNegation = false;
      } else {
        bracketCanClose = true;
        bracketMayConsumeNegation = false;
      }
    } else if (character === "^" && bracketMayConsumeNegation) {
      bracketMayConsumeNegation = false;
    } else if (!bracketCanClose) {
      bracketCanClose = true;
      bracketMayConsumeNegation = false;
    }
  }
  return result;
}

function restoreSedWildcardDots({
  regex,
  characterLocaleMode,
  dotMatchesNewline,
}: {
  regex: RegExp;
  characterLocaleMode: WeshCharacterLocaleMode;
  dotMatchesNewline: boolean;
}): RegExp {
  if (!regex.source.includes(SED_WILDCARD_DOT_SENTINEL)) return regex;
  const wildcard = (() => {
    switch (characterLocaleMode) {
    case "ascii":
      return dotMatchesNewline ? String.raw`[\s\S]` : String.raw`[^\n]`;
    case "unicode":
      return dotMatchesNewline
        ? String.raw`(?![\uDC80-\uDCFF])[\s\S]`
        : String.raw`(?![\uDC80-\uDCFF])[^\n]`;
    default: {
      const _ex: never = characterLocaleMode;
      throw new Error(`Unhandled sed character locale mode: ${_ex}`);
    }
    }
  })();
  return new RegExp(regex.source.replaceAll(SED_WILDCARD_DOT_SENTINEL, wildcard), regex.flags);
}

function compileSedRegex({
  source,
  syntax,
  global,
  characterLocaleMode,
  nullData,
  dotMatchesNewline,
}: {
  source: string;
  syntax: SedRegularExpressionSyntax;
  global: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
  nullData: boolean;
  dotMatchesNewline: boolean;
}): RegExp {
  const flags = (() => {
    const globalFlag = global ? "g" : "";
    switch (characterLocaleMode) {
    case "ascii":
      return globalFlag;
    case "unicode":
      return `${globalFlag}u`;
    default: {
      const _ex: never = characterLocaleMode;
      throw new Error(`Unhandled sed character locale mode: ${_ex}`);
    }
    }
  })();
  const normalizedSource = toSedLocaleText({
    text: normalizeSedRegularExpressionEscapes({ source }),
    characterLocaleMode,
  });
  const maskedSource = maskSedWildcardDots({ source: normalizedSource });
  const regex = (() => {
    switch (syntax) {
    case "basic":
      return compileBasicRegularExpression({
        source: maskedSource,
        flags,
        characterClassMode: characterLocaleMode,
        gnuWordOperators: true,
        basicOperatorMode: 'gnu',
        dotMode: nullData ? "non-null" : "non-newline",
        excludeSurrogateEscapes: characterLocaleMode === "unicode",
      });
    case "extended":
      return compileExtendedRegularExpression({
        source: maskedSource,
        flags,
        characterClassMode: characterLocaleMode,
        gnuWordOperators: true,
        dotMode: nullData ? "non-null" : "non-newline",
        excludeSurrogateEscapes: characterLocaleMode === "unicode",
      });
    default: {
      const _ex: never = syntax;
      throw new Error(`Unhandled sed regular expression syntax: ${_ex}`);
    }
    }
  })();
  return restoreSedWildcardDots({ regex, characterLocaleMode, dotMatchesNewline });
}

export function resolveSedRegex({
  source,
  state,
  global,
  dotMatchesNewline,
}: {
  source: string;
  state: SedRegexParseState;
  global: boolean;
  dotMatchesNewline: boolean;
}): RegExp {
  if (source.length === 0) {
    if (state.previousRegex === undefined) {
      throw new Error("no previous regular expression");
    }
    return cloneSedRegex({ regex: state.previousRegex, global });
  }

  const regex = compileSedRegex({
    source,
    syntax: state.syntax,
    global,
    characterLocaleMode: state.characterLocaleMode,
    nullData: state.nullData,
    dotMatchesNewline,
  });
  state.previousRegex = cloneSedRegex({ regex, global: false });
  state.previousCaptureCount = countSedCapturingGroups({
    source,
    syntax: state.syntax,
  });
  return regex;
}

export function applySedRegexModifiers({
  regex,
  ignoreCase,
  multiline,
  state,
}: {
  regex: RegExp;
  ignoreCase: boolean;
  multiline: boolean;
  state: SedRegexParseState;
}): RegExp {
  const flags = new Set(regex.flags);
  if (ignoreCase) flags.add("i");
  if (multiline && !state.nullData) flags.add("m");
  const modified = new RegExp(regex.source, [...flags].join("") || undefined);
  state.previousRegex = cloneSedRegex({ regex: modified, global: false });
  return modified;
}

export function readSedRegexOperand({
  script,
  index,
  delimiter,
  unterminatedMessage,
  sourceBoundaryIndices,
}: {
  script: string;
  index: number;
  delimiter: string;
  unterminatedMessage: string;
  sourceBoundaryIndices: ReadonlySet<number>;
}):
  | { ok: true; source: string; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  let source = "";
  let inBracketExpression = false;
  let bracketCanClose = false;
  let bracketMayConsumeNegation = false;

  while (cursor < script.length) {
    if (sourceBoundaryIndices.has(cursor)) {
      return { ok: false, message: unterminatedMessage };
    }
    const character = script[cursor];
    if (character === undefined) break;

    if (!inBracketExpression && character === delimiter) {
      return { ok: true, source, nextIndex: cursor + 1 };
    }

    if (character === "\n") {
      return { ok: false, message: unterminatedMessage };
    }

    if (inBracketExpression && delimiter === "\\" && character === "\\") {
      // When backslash itself is the sed regexp delimiter, a raw delimiter
      // inside a bracket expression is regexp data rather than an escape
      // prefix. Escape it for the downstream regexp compiler so the next
      // bracket character keeps its normal POSIX role.
      source += "\\\\";
      if (!bracketCanClose) {
        bracketCanClose = true;
        bracketMayConsumeNegation = false;
      }
      cursor += 1;
      continue;
    }

    if (inBracketExpression && character === "[") {
      const bracketSubexpressionEnd = findSedPosixBracketSubexpressionEnd({
        source: script,
        index: cursor,
      });
      if (bracketSubexpressionEnd !== undefined) {
        // POSIX character classes, equivalence classes, and collating symbols
        // contain their own closing bracket. Keep the whole nested token inside
        // the surrounding bracket expression so a matching sed delimiter (for
        // example `]`) cannot terminate the regexp operand early.
        source += script.slice(cursor, bracketSubexpressionEnd);
        bracketCanClose = true;
        bracketMayConsumeNegation = false;
        cursor = bracketSubexpressionEnd;
        continue;
      }
    }

    if (character === "\\") {
      const escaped = script[cursor + 1];
      if (escaped === undefined) {
        source += character;
        cursor += 1;
        continue;
      }

      if (escaped === "\n" && sourceBoundaryIndices.has(cursor + 1)) {
        return { ok: false, message: unterminatedMessage };
      }

      if (escaped === "\n") {
        // GNU sed accepts a backslash followed by a physical script newline
        // as a newline character inside a regexp operand. Normalize that
        // script-level spelling to the existing \n regexp escape before the
        // locale-aware regexp compiler processes it.
        source += "\\n";
        cursor += 2;
        continue;
      }

      if (!inBracketExpression && escaped === delimiter) {
        // GNU sed removes the regexp delimiter's escape marker outside a
        // bracket expression before compiling the regexp. Inside a bracket
        // expression the same backslash is regexp data and must be retained.
        source += delimiter;
        cursor += 2;
        continue;
      }

      source += `${character}${escaped}`;
      if (inBracketExpression) {
        // GNU regex bracket expressions treat backslash as a member rather
        // than as an escape for the closing `]`. Therefore `\]` can close
        // the bracket after the backslash itself has supplied a member. This
        // matters to sed's delimiter scanner when `]` is also the delimiter.
        if (!bracketCanClose) {
          bracketCanClose = true;
          bracketMayConsumeNegation = false;
        }
        if (escaped === "]") {
          inBracketExpression = false;
          bracketMayConsumeNegation = false;
        }
      }
      cursor += 2;
      continue;
    }

    source += character;
    if (!inBracketExpression && character === "[") {
      inBracketExpression = true;
      bracketCanClose = false;
      bracketMayConsumeNegation = true;
    } else if (inBracketExpression) {
      if (character === "]") {
        if (bracketCanClose) {
          inBracketExpression = false;
          bracketMayConsumeNegation = false;
        } else {
          // A closing bracket is literal as the first bracket member, even
          // after the optional leading negation marker.
          bracketCanClose = true;
          bracketMayConsumeNegation = false;
        }
      } else if (character === "^" && bracketMayConsumeNegation) {
        bracketMayConsumeNegation = false;
      } else if (!bracketCanClose) {
        bracketCanClose = true;
        bracketMayConsumeNegation = false;
      }
    }
    cursor += 1;
  }

  return { ok: false, message: unterminatedMessage };
}

export function parseRegexLiteral({
  script,
  index,
  state,
}: {
  script: string;
  index: number;
  state: SedRegexParseState;
}):
  | { ok: true; regex: RegExp; nextIndex: number }
  | { ok: false; message: string } {
  const first = script[index];
  const alternateDelimiter = first === "\\" ? script[index + 1] : undefined;
  const delimiter = first === "/" ? first : alternateDelimiter;
  if (delimiter === undefined) {
    return {
      ok: false,
      message: `invalid regex address near '${script.slice(index)}'`,
    };
  }
  if (!isSingleByteSedDelimiter({ delimiter })) {
    return {
      ok: false,
      message: "delimiter character is not a single-byte character",
    };
  }
  if (delimiter === "\n") {
    return { ok: false, message: "unterminated regex address" };
  }

  const operand = readSedRegexOperand({
    script,
    index: first === "/" ? index + 1 : index + 2,
    delimiter,
    unterminatedMessage: "unterminated regex address",
    sourceBoundaryIndices: state.sourceBoundaryIndices,
  });
  if (!operand.ok) return operand;

  try {
    let nextIndex = operand.nextIndex;
    let ignoreCase = false;
    let multiline = false;
    while (nextIndex < script.length) {
      const modifier = script[nextIndex];
      if (modifier === "I") {
        ignoreCase = true;
        nextIndex += 1;
        continue;
      }
      if (modifier === "M") {
        multiline = true;
        nextIndex += 1;
        continue;
      }
      break;
    }
    if (operand.source.length === 0 && (ignoreCase || multiline)) {
      return {
        ok: false,
        message: "cannot specify modifiers on empty regexp",
      };
    }
    const regex = resolveSedRegex({
      source: operand.source,
      state,
      global: false,
      dotMatchesNewline: !multiline,
    });
    return {
      ok: true,
      regex: applySedRegexModifiers({
        regex,
        ignoreCase,
        multiline,
        state,
      }),
      nextIndex,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `invalid regular expression '${operand.source}': ${message}`,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
