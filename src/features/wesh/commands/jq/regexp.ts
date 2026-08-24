import {
  exceedsSafeRegularExpressionInputLimit,
  hasPotentiallyUnsafeBacktrackingStructure,
} from '@/features/wesh/commands/_shared/backtracking-safety';
import { translatePosixCharacterClasses } from "@/features/wesh/commands/_shared/posix-regexp";
import {
  jqCaseInsensitiveBackreferenceCharactersEqual,
  jqSimpleCaseFoldCharactersHaveEquivalentBackreferenceSemantics,
  renderJqExplicitCaseFoldClassContent,
  renderJqExplicitFullCaseFoldAlternative,
  translateJqUnicodeFullCaseFoldLiteral,
  translateJqUnicodeFullCaseFolds,
} from "./full-case-fold";

const JQ_REGEXP_UTF8_ENCODER = new TextEncoder();
const JQ_MAX_RECURSIVE_SUBEXPRESSION_CALL_DEPTH = 18;
const JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH = 128;
const JQ_MAX_BOUNDED_CAPTURE_HISTORY_REPETITIONS = 32;
// Fully expanding nullable unbounded repetitions is exponential. Keep the
// bounded simple-backreference fallback to inputs whose complete expansion was
// measured below the command's existing regular-expression safety budget.
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_INPUT_CODE_POINTS = 6;
// A seventh code point is admitted only for a uniform input when longest
// matching is disabled and a global replay cannot multiply case-folded empty
// matches. This narrow runtime guard preserves the proven six-code-point
// boundary for every other input shape.
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_UNIFORM_INPUT_CODE_POINTS = 7;
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_CAPTURE_EXPRESSION_TOKENS = 41;
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_ALTERNATIVE_CODE_POINTS = 6;
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_PREFIX_CODE_POINTS = 6;
const JQ_MAX_QUANTIFIED_BACKREFERENCE_FINITE_CLASS_CODE_POINTS = 6;
const JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_REPETITIONS =
  JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_UNIFORM_INPUT_CODE_POINTS + 1;
const JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_PLAIN_REPETITIONS = 32;
const JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_PLAIN_REPETITIONS = 16;
const JQ_MAX_DYNAMIC_PLAIN_CAPTURE_HISTORY_INPUT_CODE_POINTS = 512;
const JQ_MAX_DYNAMIC_LINEAR_RUNTIME_CAPTURE_HISTORY_INPUT_CODE_POINTS = 2_048;
const JQ_MAX_DYNAMIC_LINEAR_RUNTIME_CAPTURE_HISTORY_PARTIAL_REPETITIONS = 512;
const JQ_MAX_DYNAMIC_CAPTURE_HISTORY_SOURCE_BUDGET = 32 * 1024;
// A fully expanded linear-runtime fallback with exactly one surviving exact
// runtime alternative is substantially cheaper after mandatory-current marker
// elision and compact physical backreferences. Keep the wider measured budget
// isolated to that shape; branching, case-folded, and position-marker fallbacks
// retain the original 32 KiB limit.
const JQ_MAX_DYNAMIC_LINEAR_RUNTIME_ELIDED_MARKER_SOURCE_BUDGET = 40 * 1024;
const JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_RUNTIME_MARKERS = 64;
const JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_RUNTIME_MARKERS = 24;
const JQ_MAX_UNBOUNDED_BRANCHING_HISTORY_RUNTIME_MARKERS = 5;
const JQ_MAX_UNBOUNDED_BRANCHING_HISTORY_LONGEST_RUNTIME_MARKERS = 4;
const JQ_UNSAFE_RECURSIVE_REGEXP_INPUT_LIMIT = 256;
const JQ_MAX_BACKREFERENCE_CAPTURE_ALTERNATIVES = 256;
const JQ_MAX_RUNTIME_ALTERNATIVE_STATES = 256;
const JQ_MAX_RUNTIME_FALLBACK_EVALUATIONS = 4_096;
const jqGeneratedLinearRuntimeCaptureHistoryFallbacks = new WeakSet<object>();
const JQ_LONGEST_NONRECURSIVE_SUBEXPRESSION_RETRY_LIMIT_ADDITIONAL_ALTERNATIONS =
  45;
const JQ_LONGEST_RECURSIVE_SUBEXPRESSION_RETRY_LIMIT_ADDITIONAL_ALTERNATIONS =
  208;
const JQ_SAFE_SUBEXPRESSION_BACKTRACKING_ADDITIONAL_ALTERNATIONS = 66;
const JQ_GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "grapheme",
});
const JQ_UNICODE_LETTER_REGEXP = /^\p{L}$/u;

type JqSpecialRegularExpressionMode =
  | "none"
  | "grapheme"
  | "grapheme-one-or-more"
  | "grapheme-boundary"
  | "non-grapheme-boundary";

export class JqRegularExpressionRuntimeError extends Error {
  override readonly name = "JqRegularExpressionRuntimeError";
}

class JqNeverEndingRecursionError extends Error {
  override readonly name = "JqNeverEndingRecursionError";
}

class JqRegularExpressionFailureError extends Error {
  override readonly name = "JqRegularExpressionFailureError";
}

class JqRegularExpressionSourceBudgetError extends Error {
  override readonly name = "JqRegularExpressionSourceBudgetError";
}

export interface JqRegularExpressionCapture {
  readonly start: number;
  readonly end: number;
  readonly name: string | null;
  readonly text: string | null;
}

export interface JqRegularExpressionMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly captures: readonly JqRegularExpressionCapture[];
}

export type CompileJqRegularExpressionResult =
  | {
      readonly ok: true;
      readonly create: ({
        global,
        disabledBackreferenceAlternatives,
        disabledPhysicalCaptures,
        caseFoldedBackreferenceLengthConstraints,
        preferLongestBackreferenceCandidates,
        searchStartCodePointIndex,
        disableEmptyAlternatives,
      }: {
        global: boolean;
        disabledBackreferenceAlternatives?: ReadonlySet<number>;
        disabledPhysicalCaptures?: ReadonlySet<number>;
        caseFoldedBackreferenceLengthConstraints?: ReadonlyMap<
          number,
          {
            readonly minimumCodePointLength: number;
            readonly maximumCodePointLength: number;
          }
        >;
        preferLongestBackreferenceCandidates?: boolean;
        searchStartCodePointIndex?: number;
        disableEmptyAlternatives?: boolean;
      }) => RegExp;
      readonly createIgnoreEmptyAlternatives: () => readonly RegExp[];
      readonly hasIgnoreEmptyAlternatives: boolean;
      readonly requestedGlobal: boolean;
      readonly ignoreCase: boolean;
      readonly uniformSevenCodePointCaptureHistoryReplayCompatible: boolean;
      readonly singletonRequiredSevenCodePointCaptureHistoryReplayCompatible: boolean;
      readonly wholeMatchGuardedOptionalCaptureHistoryProjectionReplay: boolean;
      readonly ignoreEmpty: boolean;
      readonly longest: boolean;
      readonly emptyByteContinuation: "none" | "any" | "word" | "non-word";
      readonly specialMode: JqSpecialRegularExpressionMode;
      readonly captureNames: readonly (string | null)[];
      readonly captureSlots: readonly (number | undefined)[];
      readonly backreferenceAlternatives: readonly {
        readonly id: number;
        readonly markerCaptureIndex: number;
        readonly targetCaptureIndex: number;
        readonly newerTargetCaptureIndexes: readonly number[];
        readonly comparison: "exact" | "case-folded";
        readonly minimumRepetitions: number;
        readonly maximumRepetitions: number | null;
        readonly greedy: boolean;
        readonly possessive: boolean;
      }[];
      readonly positionAssertions: readonly {
        readonly id: number;
        readonly markerCaptureIndex: number;
        readonly kind: "boundary" | "non-boundary" | "search-start";
      }[];
      readonly recursiveCaptureLogicalIndexes: readonly number[];
      readonly subexpressionCallExpansionAdditionalAlternationCount: number;
      readonly prioritizeEarlyRuntimeAlternativeRejections: boolean;
      readonly compileBoundedSimpleCaptureHistoryFallback:
        | (({ maximumRepetitions }: { readonly maximumRepetitions: number }) =>
          CompileJqRegularExpressionResult)
        | undefined;
      readonly compileBoundedPlainCaptureHistoryFallback:
        | (({ maximumRepetitions }: { readonly maximumRepetitions: number }) =>
          CompileJqRegularExpressionResult)
        | undefined;
      readonly compileBoundedLinearRuntimeCaptureHistoryFallback:
        | (({ maximumRepetitions }: { readonly maximumRepetitions: number }) =>
          CompileJqRegularExpressionResult)
        | undefined;
    }
  | { readonly ok: false; readonly message: string };

function escapeJqQuotedLiteralCharacter({
  character,
}: {
  character: string;
}): string {
  if (character === "#" || /\s/u.test(character)) {
    return `[${character}]`;
  }
  if (/^[\\^$.*+?()[\]{}|/]$/u.test(character)) {
    return `\\${character}`;
  }
  return character;
}

function translateJqQuotedLiterals({ source }: { source: string }): string {
  let output = "";
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (
      character !== "\\" ||
      inBracket ||
      source[index + 1] !== "Q"
    ) {
      output += character;
      if (character === "\\" && index + 1 < source.length) {
        output += source[++index]!;
      }
      continue;
    }

    const quotedStart = index + 2;
    const quotedEnd = source.indexOf("\\E", quotedStart);
    const contentEnd = quotedEnd === -1 ? source.length : quotedEnd;
    for (const quotedCharacter of source.slice(quotedStart, contentEnd)) {
      output += escapeJqQuotedLiteralCharacter({
        character: quotedCharacter,
      });
    }
    if (quotedEnd === -1) break;
    index = quotedEnd + 1;
  }
  return output;
}

function stripExtendedMode({ source }: { source: string }): string {
  let output = "";
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped !== undefined && (/\s/u.test(escaped) || escaped === "#")) {
        output += escaped;
        index += 1;
        continue;
      }
      output += character;
      if (escaped !== undefined) {
        output += escaped;
        index += 1;
      }
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (!inBracket && /\s/.test(character)) {
      continue;
    }
    if (!inBracket && character === "#") {
      while (index + 1 < source.length && source[index + 1] !== "\n")
        index += 1;
      continue;
    }
    output += character;
  }

  return output;
}

function splitTopLevelAlternatives({ source }: { source: string }): string[] {
  const alternatives: string[] = [];
  let current = "";
  let groupDepth = 0;
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      current += character;
      if (index + 1 < source.length) current += source[++index]!;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      current += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      current += character;
      continue;
    }
    if (!inBracket) {
      if (character === "(") groupDepth += 1;
      if (character === ")") groupDepth = Math.max(0, groupDepth - 1);
      if (character === "|" && groupDepth === 0) {
        alternatives.push(current);
        current = "";
        continue;
      }
    }
    current += character;
  }

  alternatives.push(current);
  return alternatives;
}

function unwrapWholeNonCapturingGroup({
  source,
}: {
  source: string;
}): string | undefined {
  if (!source.startsWith("(?:")) return undefined;
  let depth = 1;
  let inBracket = false;
  for (let index = 3; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += index + 1 < source.length ? 1 : 0;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    return index === source.length - 1
      ? source.slice(3, index)
      : undefined;
  }
  return undefined;
}

function findIgnoreEmptyAlternativeSources({
  source,
  captureNames,
}: {
  source: string;
  captureNames: readonly (string | null)[];
}): readonly string[] {
  // Independent alternatives renumber captures, so this generic nullable-path
  // fallback remains restricted to capture-free patterns. Captured explicit
  // empty alternatives use the full-source disabling path below.
  if (captureNames.length !== 0) return [];
  const topLevel = splitTopLevelAlternatives({ source });
  if (topLevel.length > 1) return topLevel;
  const unwrapped = unwrapWholeNonCapturingGroup({ source });
  if (unwrapped === undefined) return [];
  const nested = splitTopLevelAlternatives({ source: unwrapped });
  return nested.length > 1 ? nested : [];
}

interface JqSourceRange {
  readonly start: number;
  readonly end: number;
}

function emptyAlternativeRanges({
  alternatives,
  contentStart,
}: {
  alternatives: readonly string[];
  contentStart: number;
}): readonly JqSourceRange[] {
  const ranges: JqSourceRange[] = [];
  let cursor = contentStart;
  for (const alternative of alternatives) {
    if (alternative.length === 0) ranges.push({ start: cursor, end: cursor });
    cursor += alternative.length + 1;
  }
  return ranges;
}

function findIgnoreEmptyAlternativeRanges({
  source,
}: {
  source: string;
}): readonly JqSourceRange[] {
  const groupEnds = mapJqGroupEndIndexes({ source });

  const visitWholeExpression = ({
    startIndex,
    endIndex,
  }: {
    startIndex: number;
    endIndex: number;
  }): readonly JqSourceRange[] => {
    const expression = source.slice(startIndex, endIndex);
    const alternatives = splitTopLevelAlternatives({ source: expression });
    if (alternatives.length > 1) {
      const ranges = [
        ...emptyAlternativeRanges({ alternatives, contentStart: startIndex }),
      ];
      let alternativeStart = startIndex;
      for (const alternative of alternatives) {
        const alternativeEnd = alternativeStart + alternative.length;
        if (alternative.length !== 0) {
          ranges.push(...visitWholeExpression({
            startIndex: alternativeStart,
            endIndex: alternativeEnd,
          }));
        }
        alternativeStart = alternativeEnd + 1;
      }
      return ranges;
    }

    const group = parseJqGroupPrefix({ source, startIndex });
    if (group === undefined) return [];
    if (
      group.prefix === '(?='
      || group.prefix === '(?!'
      || group.prefix === '(?<='
      || group.prefix === '(?<!'
    ) return [];

    const groupEndIndex = groupEnds.get(startIndex);
    if (groupEndIndex !== endIndex - 1) return [];
    return visitWholeExpression({
      startIndex: group.contentStart,
      endIndex: groupEndIndex,
    });
  };

  return visitWholeExpression({ startIndex: 0, endIndex: source.length });
}

function translateResetMatchStart({ source }: { source: string }): string {
  return splitTopLevelAlternatives({ source })
    .map((alternative) => {
      let markerIndex = -1;
      let markerCount = 0;
      let groupDepth = 0;
      let inBracket = false;

      for (let index = 0; index < alternative.length; index += 1) {
        const character = alternative[index]!;
        if (character === "\\") {
          const next = alternative[index + 1];
          if (next === "K") {
            if (groupDepth !== 0 || inBracket)
              throw new Error("unsupported \\K placement");
            markerIndex = index;
            markerCount += 1;
          }
          index += next === undefined ? 0 : 1;
          continue;
        }
        if (character === "[" && !inBracket) {
          inBracket = true;
          continue;
        }
        if (character === "]" && inBracket) {
          inBracket = false;
          continue;
        }
        if (!inBracket) {
          if (character === "(") groupDepth += 1;
          if (character === ")") groupDepth = Math.max(0, groupDepth - 1);
        }
      }

      if (markerCount === 0) return alternative;
      if (markerCount > 1)
        throw new Error(
          "multiple \\K operators in one alternative are unsupported",
        );
      const prefix = alternative.slice(0, markerIndex);
      const suffix = alternative.slice(markerIndex + 2);
      return prefix.length === 0 ? suffix : `(?<=${prefix})${suffix}`;
    })
    .join("|");
}

const JQ_WORD_CHARACTER_CLASS_CONTENT = String.raw`\p{L}\p{M}\p{N}\p{Pc}`;
const JQ_WORD_CHARACTER_CLASS = `[${JQ_WORD_CHARACTER_CLASS_CONTENT}]`;
const JQ_NON_WORD_CHARACTER_CLASS = `[^${JQ_WORD_CHARACTER_CLASS_CONTENT}]`;
const JQ_WORD_CHARACTER_REGEXP = new RegExp(
  `^${JQ_WORD_CHARACTER_CLASS}$`,
  "u",
);
const JQ_DIGIT_CHARACTER_CLASS = String.raw`[\p{Nd}]`;
const JQ_NON_DIGIT_CHARACTER_CLASS = String.raw`[^\p{Nd}]`;
const JQ_SPACE_CHARACTER_CLASS = String.raw`[\u0009-\u000d\u0085\p{Z}]`;
const JQ_NON_SPACE_CHARACTER_CLASS = String.raw`[^\u0009-\u000d\u0085\p{Z}]`;
const JQ_WORD_BOUNDARY =
  `(?:(?<!${JQ_WORD_CHARACTER_CLASS})(?=${JQ_WORD_CHARACTER_CLASS})|` +
  `(?<=${JQ_WORD_CHARACTER_CLASS})(?!${JQ_WORD_CHARACTER_CLASS}))`;
const JQ_NON_WORD_BOUNDARY =
  `(?:(?<!${JQ_WORD_CHARACTER_CLASS})(?!${JQ_WORD_CHARACTER_CLASS})|` +
  `(?<=${JQ_WORD_CHARACTER_CLASS})(?=${JQ_WORD_CHARACTER_CLASS}))`;

interface TranslatedJqCharacterClass {
  readonly source: string;
  readonly endIndex: number;
}

interface JqComplementaryCharacterSet {
  readonly positiveOperator: string;
  readonly negativeOperator: string;
  readonly positiveClass: string;
  readonly negativeClass: string;
}

const JQ_WORD_CHARACTER_SET: JqComplementaryCharacterSet = {
  positiveOperator: "w",
  negativeOperator: "W",
  positiveClass: JQ_WORD_CHARACTER_CLASS,
  negativeClass: JQ_NON_WORD_CHARACTER_CLASS,
};
const JQ_DIGIT_CHARACTER_SET: JqComplementaryCharacterSet = {
  positiveOperator: "d",
  negativeOperator: "D",
  positiveClass: JQ_DIGIT_CHARACTER_CLASS,
  negativeClass: JQ_NON_DIGIT_CHARACTER_CLASS,
};
const JQ_SPACE_CHARACTER_SET: JqComplementaryCharacterSet = {
  positiveOperator: "s",
  negativeOperator: "S",
  positiveClass: JQ_SPACE_CHARACTER_CLASS,
  negativeClass: JQ_NON_SPACE_CHARACTER_CLASS,
};

function translateJqComplementaryCharacterClass({
  source,
  startIndex,
  set,
}: {
  source: string;
  startIndex: number;
  set: JqComplementaryCharacterSet;
}): TranslatedJqCharacterClass | undefined {
  let index = startIndex + 1;
  const negated = source[index] === "^";
  if (negated) index += 1;
  let explicitContent = "";
  let hasPositive = false;
  let hasNegative = false;
  let firstContent = true;

  for (; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) return undefined;
      if (next === set.positiveOperator) hasPositive = true;
      else if (next === set.negativeOperator) hasNegative = true;
      else explicitContent += character + next;
      index += 1;
      firstContent = false;
      continue;
    }
    if (character === "]" && !firstContent) break;
    explicitContent += character;
    firstContent = false;
  }
  if (index >= source.length || source[index] !== "]") return undefined;
  if (!hasPositive && !hasNegative) {
    return {
      source: source.slice(startIndex, index + 1),
      endIndex: index,
    };
  }

  const explicitClass = explicitContent.length === 0
    ? undefined
    : `[${explicitContent}]`;
  let translated: string;
  if (hasPositive && hasNegative) {
    translated = negated ? String.raw`(?![\s\S])` : String.raw`[\s\S]`;
  } else if (!negated) {
    const primary = hasPositive ? set.positiveClass : set.negativeClass;
    translated = explicitClass === undefined
      ? primary
      : `(?:${primary}|${explicitClass})`;
  } else {
    const complement = hasPositive ? set.negativeClass : set.positiveClass;
    translated = explicitClass === undefined
      ? complement
      : `(?:(?!${explicitClass})${complement})`;
  }
  return { source: translated, endIndex: index };
}

function translateJqComplementarySetOperators({
  source,
  set,
}: {
  source: string;
  set: JqComplementaryCharacterSet;
}): string {
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[") {
      const translatedClass = translateJqComplementaryCharacterClass({
        source,
        startIndex: index,
        set,
      });
      if (translatedClass !== undefined) {
        output += translatedClass.source;
        index = translatedClass.endIndex;
        continue;
      }
    }
    if (character !== "\\" || index + 1 >= source.length) {
      output += character;
      continue;
    }

    const next = source[index + 1]!;
    if (next === set.positiveOperator) {
      output += set.positiveClass;
      index += 1;
      continue;
    }
    if (next === set.negativeOperator) {
      output += set.negativeClass;
      index += 1;
      continue;
    }
    output += character + next;
    index += 1;
  }

  return output;
}

function translateJqWordBoundaries({ source }: { source: string }): string {
  let output = "";
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (character !== "\\" || inBracket || index + 1 >= source.length) {
      output += character;
      continue;
    }

    const next = source[index + 1]!;
    if (next === "b") {
      output += JQ_WORD_BOUNDARY;
      index += 1;
      continue;
    }
    if (next === "B") {
      output += JQ_NON_WORD_BOUNDARY;
      index += 1;
      continue;
    }
    output += character + next;
    index += 1;
  }

  return output;
}

function translateJqWordOperators({ source }: { source: string }): string {
  return translateJqComplementarySetOperators({
    source: translateJqWordBoundaries({ source }),
    set: JQ_WORD_CHARACTER_SET,
  });
}

function translateJqDigitOperators({ source }: { source: string }): string {
  return translateJqComplementarySetOperators({
    source,
    set: JQ_DIGIT_CHARACTER_SET,
  });
}

function translateJqSpaceOperators({ source }: { source: string }): string {
  return translateJqComplementarySetOperators({
    source,
    set: JQ_SPACE_CHARACTER_SET,
  });
}

const JQ_BARE_LITERAL_ALPHABETIC_ESCAPES = new Set([
  "C",
  "E",
  "F",
  "I",
  "J",
  "L",
  "M",
  "P",
  "T",
  "U",
  "g",
  "i",
  "j",
  "k",
  "l",
  "m",
  "o",
  "p",
  "q",
  "u",
]);

function getJqBareLiteralAlphabeticEscape({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): string | undefined {
  if (source[startIndex] !== "\\") return undefined;
  const escaped = source[startIndex + 1];
  if (
    escaped === undefined ||
    !JQ_BARE_LITERAL_ALPHABETIC_ESCAPES.has(escaped)
  ) {
    return undefined;
  }
  if (findJqEscapeEnd({ source, startIndex }) !== startIndex + 1) {
    return undefined;
  }
  if (escaped === "o" && source[startIndex + 2] === "{") {
    return undefined;
  }
  return escaped;
}

function isHexadecimalDigit({ character }: { character: string | undefined }): boolean {
  return character !== undefined && /^[0-9A-Fa-f]$/u.test(character);
}

type JqRawHexByteStorage = "single-byte" | "multibyte";

interface JqRawHexByteAtom {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly codePoint: number;
  readonly storage: JqRawHexByteStorage;
  readonly validScalar: boolean;
  readonly outsideClass: "literal" | "unreachable" | "error";
}

interface JqCharacterClassAtom {
  readonly source: string;
  readonly raw: boolean;
  readonly codePoint: number | undefined;
  readonly storage: JqRawHexByteStorage | undefined;
  readonly reachable: boolean;
}

type JqCharacterClassToken =
  | { readonly type: "atom"; readonly atom: JqCharacterClassAtom }
  | { readonly type: "hyphen" };

function isUtf8ContinuationByte({ byte }: { byte: number | undefined }): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function parseJqRawHexByteAtoms({
  bytes,
}: {
  bytes: readonly number[];
}): readonly JqRawHexByteAtom[] {
  const atoms: JqRawHexByteAtom[] = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      atoms.push({
        byteOffset: index,
        byteLength: 1,
        codePoint: first,
        storage: "single-byte",
        validScalar: true,
        outsideClass: "literal",
      });
      index += 1;
      continue;
    }
    if (first >= 0x80 && first <= 0xbf) {
      atoms.push({
        byteOffset: index,
        byteLength: 1,
        codePoint: first,
        storage: "single-byte",
        validScalar: false,
        outsideClass: "error",
      });
      index += 1;
      continue;
    }
    if (first >= 0xfe) {
      atoms.push({
        byteOffset: index,
        byteLength: 1,
        codePoint: first,
        storage: "single-byte",
        validScalar: false,
        outsideClass: "unreachable",
      });
      index += 1;
      continue;
    }
    if (first >= 0xf5) {
      atoms.push({
        byteOffset: index,
        byteLength: 1,
        codePoint: first,
        storage: "single-byte",
        validScalar: false,
        outsideClass: "unreachable",
      });
      index += 1;
      continue;
    }

    const byteLength = first <= 0xdf ? 2 : first <= 0xef ? 3 : 4;
    if (index + byteLength > bytes.length) {
      throw new Error("too short multibyte code string");
    }
    for (let offset = 1; offset < byteLength; offset += 1) {
      if (!isUtf8ContinuationByte({ byte: bytes[index + offset] })) {
        throw new Error("invalid code point value");
      }
    }

    let codePoint = first & (0x7f >> byteLength);
    for (let offset = 1; offset < byteLength; offset += 1) {
      codePoint = (codePoint << 6) | (bytes[index + offset]! & 0x3f);
    }
    const minimumCodePoint = byteLength === 2
      ? 0x80
      : byteLength === 3
        ? 0x800
        : 0x10000;
    const validScalar =
      codePoint >= minimumCodePoint &&
      codePoint <= 0x10ffff &&
      (codePoint < 0xd800 || codePoint > 0xdfff);
    atoms.push({
      byteOffset: index,
      byteLength,
      codePoint,
      storage: "multibyte",
      validScalar,
      outsideClass: validScalar ? "literal" : "unreachable",
    });
    index += byteLength;
  }
  return atoms;
}

function encodeJqCodePointLiteral({ codePoint }: { codePoint: number }): string {
  return `\\u{${codePoint.toString(16)}}`;
}

function translateJqRawHexByteRunOutsideClass({
  bytes,
}: {
  bytes: readonly number[];
}): string {
  return parseJqRawHexByteAtoms({ bytes }).map((atom) => {
    switch (atom.outsideClass) {
    case "literal":
      return encodeJqCodePointLiteral({ codePoint: atom.codePoint });
    case "unreachable":
      return "(?!)";
    case "error":
      throw new Error("invalid code point value");
    default: {
      const _ex: never = atom.outsideClass;
      throw new Error(`Unhandled raw hexadecimal atom: ${_ex}`);
    }
    }
  }).join("");
}

function decodeJqSingleCharacterCodePointEscape({
  operator,
}: {
  operator: string;
}): number | undefined {
  switch (operator) {
  case "0": return 0;
  case "a": return 0x07;
  case "e": return 0x1b;
  case "f": return 0x0c;
  case "n": return 0x0a;
  case "r": return 0x0d;
  case "t": return 0x09;
  case "v": return 0x0b;
  default: return undefined;
  }
}

function parseJqCodePointEscape({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): { readonly atom: JqCharacterClassAtom; readonly endIndex: number } | undefined {
  if (source[startIndex] !== "\\") return undefined;
  const operator = source[startIndex + 1];
  if ((operator === "x" || operator === "o") && source[startIndex + 2] === "{") {
    const closingIndex = source.indexOf("}", startIndex + 3);
    if (closingIndex === -1) return undefined;
    const digits = source.slice(startIndex + 3, closingIndex);
    const { digitPattern, radix } = (() => {
      switch (operator) {
      case "x":
        return { digitPattern: /^[0-9A-Fa-f]+$/u, radix: 16 };
      case "o":
        return { digitPattern: /^[0-7]+$/u, radix: 8 };
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled code point escape operator: ${_ex}`);
      }
      }
    })();
    if (!digitPattern.test(digits)) return undefined;
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return undefined;
    return {
      atom: {
        source: source.slice(startIndex, closingIndex + 1),
        raw: false,
        codePoint,
        storage: codePoint <= 0x7f ? "single-byte" : "multibyte",
        reachable: codePoint < 0xd800 || codePoint > 0xdfff,
      },
      endIndex: closingIndex,
    };
  }
  const codePoint = operator === undefined
    ? undefined
    : decodeJqSingleCharacterCodePointEscape({ operator });
  if (codePoint !== undefined) {
    return {
      atom: {
        source: source.slice(startIndex, startIndex + 2),
        raw: false,
        codePoint,
        storage: "single-byte",
        reachable: true,
      },
      endIndex: startIndex + 1,
    };
  }
  if (operator !== undefined && !/[A-Za-z0-9]/u.test(operator)) {
    const literalCodePoint = operator.codePointAt(0)!;
    return {
      atom: {
        source: source.slice(startIndex, startIndex + 2),
        raw: false,
        codePoint: literalCodePoint,
        storage: literalCodePoint <= 0x7f ? "single-byte" : "multibyte",
        reachable: true,
      },
      endIndex: startIndex + 1,
    };
  }
  return undefined;
}

function parseJqCharacterClassTokens({
  source,
}: {
  source: string;
}): { readonly negated: boolean; readonly tokens: readonly JqCharacterClassToken[] } {
  const negated = source.startsWith("^");
  const tokens: JqCharacterClassToken[] = [];
  for (let index = negated ? 1 : 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "-") {
      tokens.push({ type: "hyphen" });
      continue;
    }
    if (
      character === "\\" &&
      source[index + 1] === "x" &&
      isHexadecimalDigit({ character: source[index + 2] }) &&
      isHexadecimalDigit({ character: source[index + 3] })
    ) {
      const bytes: number[] = [];
      const runStart = index;
      let runEnd = index;
      while (
        source[runEnd] === "\\" &&
        source[runEnd + 1] === "x" &&
        isHexadecimalDigit({ character: source[runEnd + 2] }) &&
        isHexadecimalDigit({ character: source[runEnd + 3] })
      ) {
        bytes.push(Number.parseInt(source.slice(runEnd + 2, runEnd + 4), 16));
        runEnd += 4;
      }
      for (const atom of parseJqRawHexByteAtoms({ bytes })) {
        const atomStart = runStart + atom.byteOffset * 4;
        const atomEnd = atomStart + atom.byteLength * 4;
        tokens.push({
          type: "atom",
          atom: {
            source: source.slice(atomStart, atomEnd),
            raw: true,
            codePoint: atom.codePoint,
            storage: atom.storage,
            reachable: atom.validScalar,
          },
        });
      }
      index = runEnd - 1;
      continue;
    }
    if (character === "\\" && source[index + 1] === "x") {
      const firstDigit = source[index + 2];
      const hasOneDigit = isHexadecimalDigit({ character: firstDigit });
      const codePoint = hasOneDigit ? Number.parseInt(firstDigit!, 16) : 0;
      tokens.push({
        type: "atom",
        atom: {
          source: encodeJqCodePointLiteral({ codePoint }),
          raw: true,
          codePoint,
          storage: "single-byte",
          reachable: true,
        },
      });
      index += hasOneDigit ? 2 : 1;
      continue;
    }
    const escaped = parseJqCodePointEscape({ source, startIndex: index });
    if (escaped !== undefined) {
      tokens.push({ type: "atom", atom: escaped.atom });
      index = escaped.endIndex;
      continue;
    }
    if (character === "\\" && index + 1 < source.length) {
      tokens.push({
        type: "atom",
        atom: {
          source: source.slice(index, index + 2),
          raw: false,
          codePoint: undefined,
          storage: undefined,
          reachable: true,
        },
      });
      index += 1;
      continue;
    }
    const codePoint = source.codePointAt(index)!;
    const literal = String.fromCodePoint(codePoint);
    tokens.push({
      type: "atom",
      atom: {
        source: literal,
        raw: false,
        codePoint,
        storage: codePoint <= 0x7f ? "single-byte" : "multibyte",
        reachable: true,
      },
    });
    index += literal.length - 1;
  }
  return { negated, tokens };
}

function translateJqCharacterClassRange({
  start,
  end,
}: {
  start: JqCharacterClassAtom;
  end: JqCharacterClassAtom;
}): string | undefined {
  if (!start.raw && !end.raw) return undefined;
  if (
    start.codePoint === undefined ||
    start.storage === undefined ||
    end.codePoint === undefined ||
    end.storage === undefined
  ) {
    return undefined;
  }
  if (start.codePoint > end.codePoint) {
    throw new Error("empty range in char class");
  }
  const singleByteRange =
    start.storage === "single-byte" && end.storage === "single-byte";
  const lower = Math.max(start.codePoint, singleByteRange ? 0 : 0x00);
  const upper = Math.min(end.codePoint, singleByteRange ? 0x7f : 0x10ffff);
  if (lower > upper) return "";
  return `${encodeJqCodePointLiteral({ codePoint: lower })}-${encodeJqCodePointLiteral({ codePoint: upper })}`;
}

function renderJqCharacterClassAtom({
  atom,
}: {
  atom: JqCharacterClassAtom;
}): string {
  if (!atom.raw) return atom.source;
  if (!atom.reachable || atom.codePoint === undefined) return "";
  return encodeJqCodePointLiteral({ codePoint: atom.codePoint });
}

function translateJqHexEscapesInCharacterClass({
  source,
}: {
  source: string;
}): string {
  if (!source.includes("\\x")) return source;
  const { negated, tokens } = parseJqCharacterClassTokens({ source });
  let output = negated ? "^" : "";
  for (let index = 0; index < tokens.length; index += 1) {
    const start = tokens[index];
    const hyphen = tokens[index + 1];
    const end = tokens[index + 2];
    if (
      start?.type === "atom" &&
      hyphen?.type === "hyphen" &&
      end?.type === "atom"
    ) {
      const range = translateJqCharacterClassRange({
        start: start.atom,
        end: end.atom,
      });
      if (range !== undefined) {
        output += range;
        index += 2;
        continue;
      }
    }
    if (start === undefined) continue;
    switch (start.type) {
    case "atom":
      output += renderJqCharacterClassAtom({ atom: start.atom });
      break;
    case "hyphen":
      output += "-";
      break;
    default: {
      const _ex: never = start;
      throw new Error(
        `Unhandled character class token: ${String((_ex satisfies never) as unknown)}`,
      );
    }
    }
  }
  return output;
}


function translateJqHexEscapes({ source }: { source: string }): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[") {
      const classEnd = findJqCharacterClassEnd({ source, startIndex: index });
      output += "[" + translateJqHexEscapesInCharacterClass({
        source: source.slice(index + 1, classEnd),
      }) + "]";
      index = classEnd;
      continue;
    }
    if (character !== "\\" || source[index + 1] !== "x") {
      output += character;
      if (character === "\\" && index + 1 < source.length) {
        output += source[++index]!;
      }
      continue;
    }

    const firstDigit = source[index + 2];
    if (firstDigit === "{") {
      output += "\\x";
      index += 1;
      continue;
    }
    if (firstDigit === undefined || !isHexadecimalDigit({ character: firstDigit })) {
      if (index + 2 === source.length) {
        // Oniguruma treats a terminal bare \\x as the literal letter x. In every
        // other context a zero-digit hexadecimal escape denotes NUL.
        output += "x";
      } else {
        output += String.raw`\u{0}`;
      }
      index += 1;
      continue;
    }

    const secondDigit = source[index + 3];
    if (!isHexadecimalDigit({ character: secondDigit })) {
      output += encodeJqCodePointLiteral({
        codePoint: Number.parseInt(firstDigit, 16),
      });
      index += 2;
      continue;
    }

    const bytes: number[] = [];
    let runEnd = index;
    while (
      source[runEnd] === "\\" &&
      source[runEnd + 1] === "x" &&
      isHexadecimalDigit({ character: source[runEnd + 2] }) &&
      isHexadecimalDigit({ character: source[runEnd + 3] })
    ) {
      bytes.push(Number.parseInt(source.slice(runEnd + 2, runEnd + 4), 16));
      runEnd += 4;
    }
    output += translateJqRawHexByteRunOutsideClass({ bytes });
    index = runEnd - 1;
  }
  return output;
}

function translateJqBracedCodePointEscapes({
  source,
}: {
  source: string;
}): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    if (
      source[index] !== "\\" ||
      (source[index + 1] !== "x" && source[index + 1] !== "o") ||
      source[index + 2] !== "{"
    ) {
      output += source[index]!;
      continue;
    }
    const closingIndex = source.indexOf("}", index + 3);
    if (closingIndex === -1) {
      output += source[index]!;
      continue;
    }
    const operator = source[index + 1]!;
    const digits = source.slice(index + 3, closingIndex);
    const digitPattern = operator === "x" ? /^[0-9A-Fa-f]+$/u : /^[0-7]+$/u;
    if (!digitPattern.test(digits)) {
      output += source.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    const codePoint = Number.parseInt(digits, operator === "x" ? 16 : 8);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
      output += source.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }
    output += `\\u{${codePoint.toString(16)}}`;
    index = closingIndex;
  }
  return output;
}

function translateJqBareLiteralAlphabeticEscapes({
  source,
}: {
  source: string;
}): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const literal = getJqBareLiteralAlphabeticEscape({
      source,
      startIndex: index,
    });
    if (literal !== undefined) {
      output += literal;
      index += 1;
      continue;
    }
    const character = source[index]!;
    output += character;
    if (character === "\\" && index + 1 < source.length) {
      output += source[++index]!;
    }
  }
  return output;
}

function translateJqSpecialCharacterOperator({
  operator,
  inBracket,
}: {
  operator: string;
  inBracket: boolean;
}): string | undefined {
  switch (operator) {
  case "H": return "H";
  case "N": return inBracket ? "N" : String.raw`[^\n]`;
  case "O": return inBracket ? "O" : String.raw`[\s\S]`;
  case "R": return inBracket
    ? "R"
    : String.raw`(?:\r\n|[\n\v\f\r\u0085\u2028\u2029])`;
  case "V": return "V";
  case "a": return String.raw`\u0007`;
  case "e": return String.raw`\u001b`;
  case "h": return "h";
  case "v": return "v";
  default: return undefined;
  }
}

function translateJqSpecialCharacterOperators({
  source,
}: {
  source: string;
}): string {
  let output = "";
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (character !== "\\" || index + 1 >= source.length) {
      output += character;
      continue;
    }
    const next = source[index + 1]!;
    const translation = translateJqSpecialCharacterOperator({ operator: next, inBracket });
    if (translation !== undefined) {
      output += translation;
      index += 1;
      continue;
    }
    output += character + next;
    index += 1;
  }
  return output;
}

function translateJqDotOperators({ source }: { source: string }): string {
  let output = "";
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      output += character;
      if (index + 1 < source.length) output += source[++index]!;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    output += character === "." && !inBracket ? String.raw`[^\n]` : character;
  }
  return output;
}

function translateAbsoluteAnchors({ source }: { source: string }): string {
  let output = "";
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (!inBracket && character === "$") {
      // jq lets $ match immediately before one final LF and at absolute end.
      // Use an explicit assertion so later flag handling cannot broaden it.
      output += String.raw`(?=\n?$)`;
      continue;
    }
    if (character !== "\\" || index + 1 >= source.length) {
      output += character;
      continue;
    }

    const next = source[index + 1]!;
    if (inBracket && (next === "A" || next === "Z" || next === "z")) {
      output += next;
      index += 1;
      continue;
    }
    if (!inBracket && next === "A") {
      output += "^";
      index += 1;
      continue;
    }
    if (!inBracket && next === "Z") {
      output += String.raw`(?=\n?$)`;
      index += 1;
      continue;
    }
    if (!inBracket && next === "z") {
      output += String.raw`$(?![\s\S])`;
      index += 1;
      continue;
    }
    output += character + next;
    index += 1;
  }

  return output;
}

interface WholeInlineModifierGroup {
  readonly source: string;
  readonly enabled: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
}

function unwrapWholeInlineModifierGroup({
  source,
}: {
  source: string;
}): WholeInlineModifierGroup | undefined {
  const prefix = /^\(\?([imsx]*)(?:-([imsx]+))?:/u.exec(source);
  if (prefix === null) return undefined;
  const enabled = new Set(prefix[1] ?? "");
  const disabled = new Set(prefix[2] ?? "");
  if (enabled.size === 0 && disabled.size === 0) return undefined;

  let depth = 1;
  let inBracket = false;
  for (let index = prefix[0].length; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += index + 1 < source.length ? 1 : 0;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket) continue;
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    if (index !== source.length - 1) return undefined;
    return {
      source: source.slice(prefix[0].length, index),
      enabled,
      disabled,
    };
  }
  return undefined;
}

function resolveScopedModifier({
  initial,
  modifier,
  scoped,
}: {
  initial: boolean;
  modifier: string;
  scoped: WholeInlineModifierGroup | undefined;
}): boolean {
  if (scoped?.enabled.has(modifier) === true) return true;
  if (scoped?.disabled.has(modifier) === true) return false;
  return initial;
}

function consumeLeadingInlineModifiers({ source }: { source: string }): {
  source: string;
  modifiers: ReadonlySet<string>;
} {
  const modifiers = new Set<string>();
  let remaining = source;

  while (true) {
    const match = /^\(\?([imsx]+)\)/u.exec(remaining);
    if (match === null) break;
    for (const modifier of match[1]!) modifiers.add(modifier);
    remaining = remaining.slice(match[0].length);
  }

  return { source: remaining, modifiers };
}

interface JqLocalModifierState {
  readonly ignoreCase: boolean;
  readonly multilineAnchors: boolean;
  readonly dotAll: boolean;
  readonly extendedMode: boolean;
}

function applyJqModifierChanges({
  state,
  enabled,
  disabled,
}: {
  state: JqLocalModifierState;
  enabled: string;
  disabled: string;
}): JqLocalModifierState {
  const resolve = ({
    modifier,
    current,
  }: {
    modifier: string;
    current: boolean;
  }): boolean => {
    if (enabled.includes(modifier)) return true;
    if (disabled.includes(modifier)) return false;
    return current;
  };
  return {
    ignoreCase: resolve({ modifier: "i", current: state.ignoreCase }),
    multilineAnchors: resolve({
      modifier: "m",
      current: state.multilineAnchors,
    }),
    dotAll: resolve({ modifier: "s", current: state.dotAll }),
    extendedMode: resolve({ modifier: "x", current: state.extendedMode }),
  };
}

function findJqEscapeEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  const escaped = source[startIndex + 1];
  if (escaped === undefined) return startIndex;
  const delimiter = source[startIndex + 2];
  if (
    (escaped === "p" ||
      escaped === "P" ||
      escaped === "o" ||
      escaped === "x") &&
    delimiter === "{"
  ) {
    const end = source.indexOf("}", startIndex + 3);
    return end === -1 ? startIndex + 1 : end;
  }
  if (
    (escaped === "k" || escaped === "g") &&
    (delimiter === "<" || delimiter === "'")
  ) {
    const closing = (() => {
      switch (delimiter) {
      case "<":
        return ">";
      case "'":
        return "'";
      default: {
        const _exhaustive: never = delimiter;
        throw new Error(`Unhandled delimiter: ${_exhaustive}`);
      }
      }
    })();
    const end = source.indexOf(closing, startIndex + 3);
    return end === -1 ? startIndex + 1 : end;
  }
  if (escaped === "x" && /^[0-9A-Fa-f]{2}/u.test(source.slice(startIndex + 2)))
    return startIndex + 3;
  if (escaped === "c" && source[startIndex + 2] !== undefined)
    return startIndex + 2;
  return startIndex + 1;
}

function findJqCharacterClassEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  let index = startIndex + 1;
  if (source[index] === "^") index += 1;
  if (source[index] === "]") return index;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    const marker = source[index + 1];
    if (
      source[index] === "[" &&
      (marker === ":" || marker === "." || marker === "=")
    ) {
      const nestedEnd = source.indexOf(`${marker}]`, index + 2);
      if (nestedEnd !== -1) {
        index = nestedEnd + 1;
        continue;
      }
    }
    if (source[index] === "]") return index;
  }
  throw new Error("unterminated regular expression character class");
}

type JqModifierHeader = {
  readonly enabled: string,
  readonly disabled: string,
  readonly marker: ':' | ')',
  readonly endIndex: number,
};

function consumeJqModifierHeader({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): JqModifierHeader | undefined {
  if (source[startIndex] !== '(' || source[startIndex + 1] !== '?') return undefined;
  let index = startIndex + 2;
  const enabledStart = index;
  while (
    source[index] === 'i'
    || source[index] === 'm'
    || source[index] === 's'
    || source[index] === 'x'
  ) index += 1;
  const enabled = source.slice(enabledStart, index);
  let disabled = '';
  if (source[index] === '-') {
    index += 1;
    const disabledStart = index;
    while (
      source[index] === 'i'
      || source[index] === 'm'
      || source[index] === 's'
      || source[index] === 'x'
    ) index += 1;
    if (index === disabledStart) return undefined;
    disabled = source.slice(disabledStart, index);
  }
  const marker = source[index];
  if (marker !== ':' && marker !== ')') return undefined;
  return { enabled, disabled, marker, endIndex: index + 1 };
}

function mapJqGroupEndIndexes({ source }: { source: string }): ReadonlyMap<number, number> {
  const groupStarts: number[] = [];
  const groupEnds = new Map<number, number>();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === '[') {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (character === '(') {
      groupStarts.push(index);
      continue;
    }
    if (character !== ')') continue;
    const groupStart = groupStarts.pop();
    if (groupStart !== undefined) groupEnds.set(groupStart, index);
  }
  return groupEnds;
}


function translateJqAsciiCaseInsensitiveBracket({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): { readonly source: string; readonly endIndex: number } {
  const classEnd = findJqCharacterClassEnd({ source, startIndex });
  let translated = "[";
  let index = startIndex + 1;
  const negated = source[index] === "^";
  if (negated) translated += source[index++]!;
  let hasClassContent = false;
  if (source[index] === "]") {
    translated += source[index++]!;
    hasClassContent = true;
  }
  const fullFoldAlternatives: string[] = [];

  const appendCharacter = ({ character }: { character: string }): void => {
    const fullFoldAlternative = renderJqExplicitFullCaseFoldAlternative({
      character,
    });
    if (!negated && fullFoldAlternative !== undefined) {
      fullFoldAlternatives.push(fullFoldAlternative);
      return;
    }
    translated += renderJqExplicitCaseFoldClassContent({ character });
    hasClassContent = true;
  };

  for (; index < classEnd; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const bareLiteral = getJqBareLiteralAlphabeticEscape({
        source,
        startIndex: index,
      });
      if (bareLiteral !== undefined) {
        appendCharacter({ character: bareLiteral });
        index += 1;
        continue;
      }
      const escapeEnd = findJqEscapeEnd({ source, startIndex: index });
      translated += source.slice(index, escapeEnd + 1);
      hasClassContent = true;
      index = escapeEnd;
      continue;
    }
    const nestedMarker = source[index + 1];
    if (
      character === "[" &&
      (nestedMarker === ":" || nestedMarker === "." || nestedMarker === "=")
    ) {
      const nestedEnd = source.indexOf(`${nestedMarker}]`, index + 2);
      if (nestedEnd === -1 || nestedEnd >= classEnd)
        throw new Error("unterminated regular expression character class");
      const expression = source.slice(index, nestedEnd + 2);
      translated +=
        expression === "[:lower:]" || expression === "[:upper:]"
          ? "[:alpha:]"
          : expression;
      hasClassContent = true;
      index = nestedEnd + 1;
      continue;
    }
    const rangeEnd = source[index + 2];
    if (
      source[index + 1] === "-" &&
      rangeEnd !== undefined &&
      index + 2 < classEnd
    ) {
      const range = `${character}-${rangeEnd}`;
      translated += range;
      hasClassContent = true;
      if (/^[a-z]-[a-z]$/u.test(range))
        translated += `${character.toUpperCase()}-${rangeEnd.toUpperCase()}`;
      if (/^[A-Z]-[A-Z]$/u.test(range))
        translated += `${character.toLowerCase()}-${rangeEnd.toLowerCase()}`;
      if (
        !/^[A-Za-z]-[A-Za-z]$/u.test(range) &&
        (character.toLocaleLowerCase() !== character.toLocaleUpperCase() ||
          rangeEnd.toLocaleLowerCase() !== rangeEnd.toLocaleUpperCase())
      ) {
        throw new Error(
          "non-ASCII local regular expression case-folded ranges are unsupported",
        );
      }
      index += 2;
      continue;
    }
    const codePointCharacter = String.fromCodePoint(source.codePointAt(index)!);
    appendCharacter({ character: codePointCharacter });
    index += codePointCharacter.length - 1;
  }

  const alternatives: string[] = [];
  if (hasClassContent) alternatives.push(`${translated}]`);
  alternatives.push(...new Set(fullFoldAlternatives));
  if (alternatives.length === 0) alternatives.push(`${translated}]`);
  return {
    source: alternatives.length === 1
      ? alternatives[0]!
      : `(?:${alternatives.join("|")})`,
    endIndex: classEnd,
  };
}

function parseJqGroupPrefix({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { readonly prefix: string; readonly contentStart: number } | undefined {
  for (const prefix of ['(?<=', '(?<!', '(?:', '(?=', '(?!'] as const) {
    if (source.startsWith(prefix, startIndex)) {
      return { prefix, contentStart: startIndex + prefix.length };
    }
  }
  if (source.startsWith('(?<', startIndex) && /^[A-Za-z]$/u.test(source[startIndex + 3] ?? '')) {
    let index = startIndex + 4;
    while (/^[A-Za-z0-9_]$/u.test(source[index] ?? '')) index += 1;
    if (source[index] === '>') {
      return { prefix: source.slice(startIndex, index + 1), contentStart: index + 1 };
    }
  }
  if (source[startIndex] === '(') return { prefix: '(', contentStart: startIndex + 1 };
  return undefined;
}

function findJqLocalModifierQuantifierEnd({
  source,
  startIndex,
  endIndex,
}: {
  source: string,
  startIndex: number,
  endIndex: number,
}): number | undefined {
  const marker = source[startIndex];
  let quantifierEnd: number;
  if (marker === '*' || marker === '+' || marker === '?') {
    quantifierEnd = startIndex + 1;
  } else if (marker === '{') {
    const match = /^\{\d+(?:,\d*)?\}/u.exec(source.slice(startIndex, endIndex));
    if (match === null) return undefined;
    quantifierEnd = startIndex + match[0].length;
  } else {
    return undefined;
  }
  if (
    quantifierEnd < endIndex
    && (source[quantifierEnd] === '?' || source[quantifierEnd] === '+')
  ) quantifierEnd += 1;
  return quantifierEnd;
}

function translateJqLocalModifierSegment({
  source,
  initialState,
  insideGroup,
}: {
  source: string,
  initialState: JqLocalModifierState,
  insideGroup: boolean,
}): string {
  type JqRegexRope = string | readonly JqRegexRope[];
  type TranslationFrame = {
    index: number,
    readonly endIndex: number,
    state: JqLocalModifierState,
    readonly insideGroup: boolean,
    readonly parts: JqRegexRope[],
    literalRun: string,
    readonly continuation: {
      readonly prefix: string,
      readonly groupEndIndex: number,
    } | undefined,
  };

  const flushLiteralRun = ({ frame }: { frame: TranslationFrame }): void => {
    if (frame.literalRun.length === 0) return;
    frame.parts.push(
      frame.state.ignoreCase
        ? translateJqUnicodeFullCaseFoldLiteral({
          literal: frame.literalRun,
          mode: 'explicit',
        })
        : frame.literalRun,
    );
    frame.literalRun = '';
  };
  const appendLiteralAtom = ({
    frame,
    literal,
    nextIndex,
  }: {
    frame: TranslationFrame,
    literal: string,
    nextIndex: number,
  }): void => {
    const quantifierEnd = findJqLocalModifierQuantifierEnd({
      source,
      startIndex: nextIndex,
      endIndex: frame.endIndex,
    });
    if (quantifierEnd === undefined) {
      frame.literalRun += literal;
      frame.index = nextIndex;
      return;
    }
    flushLiteralRun({ frame });
    frame.parts.push(
      frame.state.ignoreCase
        ? translateJqUnicodeFullCaseFoldLiteral({
          literal,
          mode: 'explicit',
        })
        : literal,
      source.slice(nextIndex, quantifierEnd),
    );
    frame.index = quantifierEnd;
  };

  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  const frames: TranslationFrame[] = [{
    index: 0,
    endIndex: source.length,
    state: initialState,
    insideGroup,
    parts: [],
    literalRun: '',
    continuation: undefined,
  }];
  let root: JqRegexRope | undefined;
  let localCaseFoldedBackreferenceSequence = 0;

  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.index >= frame.endIndex) {
      flushLiteralRun({ frame });
      frames.pop();
      const completed: JqRegexRope = frame.parts;
      const continuation = frame.continuation;
      if (continuation === undefined) {
        root = completed;
        break;
      }
      const parent = frames.at(-1);
      if (parent === undefined) {
        throw new Error('jq regular expression parent frame is missing');
      }
      parent.parts.push([continuation.prefix, completed, ')']);
      parent.index = continuation.groupEndIndex + 1;
      continue;
    }

    const character = source[frame.index]!;
    if (character === '\\') {
      const bareLiteral = getJqBareLiteralAlphabeticEscape({
        source,
        startIndex: frame.index,
      });
      if (bareLiteral !== undefined) {
        appendLiteralAtom({
          frame,
          literal: bareLiteral,
          nextIndex: frame.index + 2,
        });
        continue;
      }
      flushLiteralRun({ frame });
      const escaped = source[frame.index + 1];
      const backreference = parseJqRegularExpressionBackreference({
        source,
        startIndex: frame.index,
      });
      if (frame.state.ignoreCase && backreference !== undefined) {
        localCaseFoldedBackreferenceSequence += 1;
        frame.parts.push(
          `(?<jqInternalLocalCaseFoldBackreference${localCaseFoldedBackreferenceSequence}>)`,
          source.slice(frame.index, backreference.endIndex + 1),
        );
        frame.index = backreference.endIndex + 1;
        continue;
      }
      if (frame.state.ignoreCase && escaped === 'k') {
        throw new Error(
          'case-insensitive regular expression backreferences are unsupported',
        );
      }
      const escapeEnd = findJqEscapeEnd({
        source,
        startIndex: frame.index,
      });
      frame.parts.push(
        source.slice(frame.index, Math.min(escapeEnd + 1, frame.endIndex)),
      );
      frame.index = Math.min(escapeEnd + 1, frame.endIndex);
      continue;
    }
    if (character === '[') {
      flushLiteralRun({ frame });
      if (!frame.state.ignoreCase) {
        const bracketEnd = findJqCharacterClassEnd({
          source,
          startIndex: frame.index,
        });
        if (bracketEnd >= frame.endIndex) {
          throw new Error('unterminated regular expression character class');
        }
        frame.parts.push(source.slice(frame.index, bracketEnd + 1));
        frame.index = bracketEnd + 1;
        continue;
      }
      const bracket = translateJqAsciiCaseInsensitiveBracket({
        source,
        startIndex: frame.index,
      });
      if (bracket.endIndex >= frame.endIndex) {
        throw new Error('unterminated regular expression character class');
      }
      frame.parts.push(bracket.source);
      frame.index = bracket.endIndex + 1;
      continue;
    }
    if (frame.state.extendedMode && /\s/u.test(character)) {
      frame.index += 1;
      continue;
    }
    if (frame.state.extendedMode && character === '#') {
      const newlineIndex = source.indexOf('\n', frame.index + 1);
      if (newlineIndex === -1 || newlineIndex >= frame.endIndex) {
        if (frame.insideGroup) {
          throw new Error('unterminated regular expression modifier group');
        }
        frame.index = frame.endIndex;
        continue;
      }
      frame.index = newlineIndex + 1;
      continue;
    }
    if (character === '.') {
      flushLiteralRun({ frame });
      frame.parts.push(frame.state.dotAll ? '[\\s\\S]' : '.');
      frame.index += 1;
      continue;
    }
    if (character === '^') {
      flushLiteralRun({ frame });
      frame.parts.push(frame.state.multilineAnchors
        ? '(?:(?<![\\s\\S])|(?<=\\n))'
        : '(?<![\\s\\S])');
      frame.index += 1;
      continue;
    }
    if (character === '$') {
      flushLiteralRun({ frame });
      frame.parts.push(frame.state.multilineAnchors
        ? '(?:(?![\\s\\S])|(?=\\n))'
        : '(?![\\s\\S])');
      frame.index += 1;
      continue;
    }
    if (character === '(' && source[frame.index + 1] === '?') {
      const modifier = consumeJqModifierHeader({
        source,
        startIndex: frame.index,
      });
      if (
        modifier !== undefined
        && (modifier.enabled.length > 0 || modifier.disabled.length > 0)
      ) {
        flushLiteralRun({ frame });
        const nextState = applyJqModifierChanges({
          state: frame.state,
          enabled: modifier.enabled,
          disabled: modifier.disabled,
        });
        switch (modifier.marker) {
        case ')':
          frame.state = nextState;
          frame.index = modifier.endIndex;
          continue;
        case ':': {
          const groupEndIndex = groupEndIndexes.get(frame.index);
          if (groupEndIndex === undefined || groupEndIndex >= frame.endIndex) {
            throw new Error('unterminated regular expression group');
          }
          frames.push({
            index: modifier.endIndex,
            endIndex: groupEndIndex,
            state: nextState,
            insideGroup: true,
            parts: [],
            literalRun: '',
            continuation: { prefix: '(?:', groupEndIndex },
          });
          continue;
        }
        default: {
          const _ex: never = modifier.marker;
          throw new Error(`Unhandled jq regular expression modifier marker: ${_ex}`);
        }
        }
      }
    }
    if (character === '(') {
      const group = parseJqGroupPrefix({
        source,
        startIndex: frame.index,
      });
      if (group !== undefined) {
        flushLiteralRun({ frame });
        const groupEndIndex = groupEndIndexes.get(frame.index);
        if (groupEndIndex === undefined || groupEndIndex >= frame.endIndex) {
          throw new Error('unterminated regular expression group');
        }
        frames.push({
          index: group.contentStart,
          endIndex: groupEndIndex,
          state: frame.state,
          insideGroup: true,
          parts: [],
          literalRun: '',
          continuation: { prefix: group.prefix, groupEndIndex },
        });
        continue;
      }
    }
    if (/[)*+?{}|]/u.test(character)) {
      flushLiteralRun({ frame });
      frame.parts.push(character);
      frame.index += 1;
      continue;
    }
    const literal = String.fromCodePoint(source.codePointAt(frame.index)!);
    appendLiteralAtom({
      frame,
      literal,
      nextIndex: frame.index + literal.length,
    });
  }

  if (root === undefined) {
    throw new Error('jq regular expression translation did not produce output');
  }
  const flattened: string[] = [];
  const pending: JqRegexRope[] = [root];
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

function containsJqLocalModifier({ source }: { source: string }): boolean {
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === '[' && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === ']' && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket || character !== '(' || source[index + 1] !== '?') continue;
    const modifier = consumeJqModifierHeader({ source, startIndex: index });
    if (modifier === undefined) continue;
    if (modifier.enabled.length === 0 && modifier.disabled.length === 0) continue;
    if (index !== 0 || modifier.marker === ':') return true;
    index = modifier.endIndex - 1;
  }
  return false;
}

function captureNamesFromSource({
  source,
}: {
  source: string;
}): readonly (string | null)[] {
  const names: (string | null)[] = [];
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += index + 1 < source.length ? 1 : 0;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket || character !== "(") continue;

    if (source[index + 1] !== "?") {
      names.push(null);
      continue;
    }

    if (source[index + 2] !== "<") continue;
    const marker = source[index + 3];
    if (marker === "=" || marker === "!") continue;
    const end = source.indexOf(">", index + 3);
    if (end === -1) continue;
    names.push(source.slice(index + 3, end));
  }

  return names;
}


function invalidJqUserCaptureName({
  source,
}: {
  source: string;
}): string | undefined {
  return captureNamesFromSource({ source }).find(
    (name): name is string => name?.includes("$") === true,
  );
}


interface JqCapturingGroupDescriptor {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly contentStartIndex: number;
  readonly logicalIndex: number;
  readonly name: string | null;
}

interface JqSubexpressionCall {
  readonly endIndex: number;
  readonly reference: string;
}

interface JqRegularExpressionBackreference {
  readonly endIndex: number;
  readonly reference: string;
}

function collectJqCapturingGroups({
  source,
}: {
  source: string;
}): readonly JqCapturingGroupDescriptor[] {
  const groupEnds = mapJqGroupEndIndexes({ source });
  const groups: JqCapturingGroupDescriptor[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (character !== "(") continue;
    const endIndex = groupEnds.get(index);
    if (endIndex === undefined) continue;
    if (source[index + 1] !== "?") {
      groups.push({
        startIndex: index,
        endIndex,
        contentStartIndex: index + 1,
        logicalIndex: groups.length,
        name: null,
      });
      continue;
    }
    if (source[index + 2] !== "<") continue;
    const marker = source[index + 3];
    if (marker === "=" || marker === "!") continue;
    const nameEnd = source.indexOf(">", index + 3);
    if (nameEnd === -1 || nameEnd >= endIndex) continue;
    groups.push({
      startIndex: index,
      endIndex,
      contentStartIndex: nameEnd + 1,
      logicalIndex: groups.length,
      name: source.slice(index + 3, nameEnd),
    });
  }
  return groups;
}

function parseJqSubexpressionCall({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): JqSubexpressionCall | undefined {
  if (source[startIndex] !== "\\" || source[startIndex + 1] !== "g") {
    return undefined;
  }
  const opening = source[startIndex + 2];
  let closing: string;
  switch (opening) {
  case "<":
    closing = ">";
    break;
  case "'":
    closing = "'";
    break;
  default:
    return undefined;
  }
  const endIndex = source.indexOf(closing, startIndex + 3);
  if (endIndex === -1) return undefined;
  return {
    endIndex,
    reference: source.slice(startIndex + 3, endIndex),
  };
}

function parseJqRegularExpressionBackreference({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): JqRegularExpressionBackreference | undefined {
  if (source[startIndex] !== "\\") return undefined;
  const escaped = source[startIndex + 1];
  if (escaped !== undefined && /[1-9]/u.test(escaped)) {
    let endIndex = startIndex + 1;
    while (/\d/u.test(source[endIndex + 1] ?? "")) endIndex += 1;
    return {
      endIndex,
      reference: source.slice(startIndex + 1, endIndex + 1),
    };
  }
  if (escaped !== "k") return undefined;
  const opening = source[startIndex + 2];
  let closing: string;
  switch (opening) {
  case "<":
    closing = ">";
    break;
  case "'":
    closing = "'";
    break;
  default:
    return undefined;
  }
  const endIndex = source.indexOf(closing, startIndex + 3);
  if (endIndex === -1) return undefined;
  return {
    endIndex,
    reference: source.slice(startIndex + 3, endIndex),
  };
}

function countJqRuntimeValidationMarkers({
  source,
  startIndex,
  endIndex,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
}): number {
  let count = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] !== "\\") continue;
    const backreference = parseJqRegularExpressionBackreference({
      source,
      startIndex: index,
    });
    if (backreference !== undefined) {
      count += 1;
      index = backreference.endIndex;
      continue;
    }
    const positionOperator = source[index + 1];
    if (
      positionOperator === "y"
      || positionOperator === "Y"
      || positionOperator === "G"
    ) count += 1;
    const call = parseJqSubexpressionCall({ source, startIndex: index });
    if (call !== undefined) {
      count += 1;
      index = call.endIndex;
      continue;
    }
    index = findJqEscapeEnd({ source, startIndex: index });
  }
  return count;
}

function jqCaptureDefinitelyParticipatesBeforeBackreference({
  source,
  target,
  backreferenceStartIndex,
  segmentStartIndex,
  segmentEndIndex,
  groupEndIndexes,
}: {
  source: string;
  target: JqCapturingGroupDescriptor;
  backreferenceStartIndex: number;
  segmentStartIndex: number;
  segmentEndIndex: number;
  groupEndIndexes: ReadonlyMap<number, number>;
}): boolean {
  if (
    target.startIndex < segmentStartIndex ||
    target.endIndex >= backreferenceStartIndex ||
    backreferenceStartIndex >= segmentEndIndex
  ) return false;

  const parentGroupStart = ({ position }: { position: number }): number | undefined => {
    let parent: number | undefined;
    for (const [startIndex, endIndex] of groupEndIndexes) {
      if (startIndex < position && position < endIndex) {
        if (parent === undefined || startIndex > parent) parent = startIndex;
      }
    }
    return parent;
  };
  const targetParent = parentGroupStart({ position: target.startIndex });
  const backreferenceParent = parentGroupStart({ position: backreferenceStartIndex });
  if (targetParent !== backreferenceParent) return false;

  const parentContentStart = targetParent === undefined
    ? segmentStartIndex
    : parseJqGroupPrefix({ source, startIndex: targetParent })?.contentStart
      ?? targetParent + 1;
  let branchStart = Math.max(segmentStartIndex, parentContentStart);
  let inBracket = false;
  let nestedDepth = 0;
  for (let index = branchStart; index < backreferenceStartIndex; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket) continue;
    if (character === "(") {
      nestedDepth += 1;
      continue;
    }
    if (character === ")") {
      nestedDepth = Math.max(0, nestedDepth - 1);
      continue;
    }
    if (character === "|" && nestedDepth === 0) branchStart = index + 1;
  }
  if (target.startIndex < branchStart) return false;

  const quantifier = parseJqProgressQuantifier({
    source,
    startIndex: target.endIndex + 1,
    endIndex: segmentEndIndex,
  });
  if (quantifier?.minimumRepetitions === 0) return false;

  const group = parseJqGroupPrefix({ source, startIndex: target.startIndex });
  if (group === undefined) return false;
  return !jqExpressionCanMatchEmpty({
    source,
    startIndex: group.contentStart,
    endIndex: target.endIndex,
    groupEndIndexes,
  });
}

function unboundedCaptureHistoryPrefixRepetitions({
  runtimeMarkerCount,
  longest,
  linearRuntimeCandidates,
}: {
  runtimeMarkerCount: number;
  longest: boolean;
  linearRuntimeCandidates: boolean;
}): number {
  if (runtimeMarkerCount === 0) {
    return longest
      ? JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_PLAIN_REPETITIONS
      : JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_PLAIN_REPETITIONS;
  }
  const markerBudget = linearRuntimeCandidates
    ? longest
      ? JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_RUNTIME_MARKERS
      : JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_RUNTIME_MARKERS
    : longest
      ? JQ_MAX_UNBOUNDED_BRANCHING_HISTORY_LONGEST_RUNTIME_MARKERS
      : JQ_MAX_UNBOUNDED_BRANCHING_HISTORY_RUNTIME_MARKERS;
  return Math.max(1, Math.floor(markerBudget / runtimeMarkerCount));
}

function containsJqRegularExpressionBackreference({
  source,
}: {
  source: string;
}): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] !== "\\") continue;
    const escaped = source[index + 1];
    if (escaped !== undefined && /[1-9]/u.test(escaped)) return true;
    if (
      escaped === "k" &&
      (source[index + 2] === "<" || source[index + 2] === "'")
    ) {
      return true;
    }
    index = findJqEscapeEnd({ source, startIndex: index });
  }
  return false;
}

function isJqSimpleSingleCodePointCaptureAtom({
  source,
}: {
  source: string;
}): boolean {
  const startsWithCharacterClass = source.startsWith("[")
    && findJqCharacterClassEnd({ source, startIndex: 0 }) === source.length - 1;
  const escapeEndIndex = source.startsWith("\\")
    ? findJqEscapeEnd({ source, startIndex: 0 })
    : undefined;
  const escaped = source[1];
  const startsWithEscape = escapeEndIndex === source.length - 1
    && parseJqRegularExpressionBackreference({
      source,
      startIndex: 0,
    }) === undefined
    && parseJqSubexpressionCall({ source, startIndex: 0 }) === undefined
    && (
      (
        source.length === 2
        && escaped !== undefined
        && (
          !/[A-Za-z0-9]/u.test(escaped)
          || /[dDsSwWhHvV]/u.test(escaped)
        )
      )
      || /^\\[pP]\{[^{}]+\}$/u.test(source)
    );
  const firstCodePoint = String.fromCodePoint(source.codePointAt(0) ?? 0);
  const isLiteral = source.length !== 0
    && firstCodePoint.length === source.length
    && !/[\\^$.*+?()[\]{}|]/u.test(firstCodePoint);
  return startsWithCharacterClass || startsWithEscape || isLiteral;
}

function jqSimpleBoundedCaptureAlternativeAtomCount({
  source,
  maximumAtomCount,
}: {
  source: string;
  maximumAtomCount: number;
}): number | undefined {
  let atomCount = 0;
  for (let index = 0; index < source.length;) {
    const endIndex = source[index] === "["
      ? findJqCharacterClassEnd({ source, startIndex: index })
      : source[index] === "\\"
        ? findJqEscapeEnd({ source, startIndex: index })
        : index + String.fromCodePoint(source.codePointAt(index) ?? 0).length - 1;
    const atom = source.slice(index, endIndex + 1);
    if (!isJqSimpleSingleCodePointCaptureAtom({ source: atom })) return undefined;
    atomCount += 1;
    if (atomCount > maximumAtomCount) return undefined;
    index = endIndex + 1;
  }
  return atomCount === 0 ? undefined : atomCount;
}

function isJqSimpleBoundedCaptureAlternative({
  source,
  maximumAtomCount,
}: {
  source: string;
  maximumAtomCount: number;
}): boolean {
  return jqSimpleBoundedCaptureAlternativeAtomCount({
    source,
    maximumAtomCount,
  }) !== undefined;
}

function isJqSimpleBoundedCaptureExpression({
  source,
}: {
  source: string;
}): boolean {
  let remainingExpressionTokens =
    JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_CAPTURE_EXPRESSION_TOKENS;
  let alternativeStartIndex = 0;
  const consumeAlternative = ({
    endIndex,
    includesSeparator,
  }: {
    endIndex: number;
    includesSeparator: boolean;
  }): boolean => {
    const atomCount = jqSimpleBoundedCaptureAlternativeAtomCount({
      source: source.slice(alternativeStartIndex, endIndex),
      maximumAtomCount:
        JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_ALTERNATIVE_CODE_POINTS,
    });
    if (atomCount === undefined) return false;
    remainingExpressionTokens -= atomCount + (includesSeparator ? 1 : 0);
    alternativeStartIndex = endIndex + (includesSeparator ? 1 : 0);
    return remainingExpressionTokens >= 0;
  };
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] === "(" || source[index] === ")") return false;
    if (source[index] !== "|") continue;
    if (!consumeAlternative({ endIndex: index, includesSeparator: true })) {
      return false;
    }
  }
  return consumeAlternative({
    endIndex: source.length,
    includesSeparator: false,
  });
}

// A syntactically single atom is not necessarily a finite runtime character
// set: dot, shorthand/property classes, ranges, and negated classes can capture
// case-fold edges that do not appear in the pattern source. Quantified replay
// is admitted only when every possible target code point can be checked here.
function jqQuantifiedBackreferenceTargetFiniteCharacters({
  source,
}: {
  source: string;
}): readonly string[] | undefined {
  const parseLiteralAtom = ({
    atom,
  }: {
    atom: string;
  }): string | undefined => {
    if (atom.startsWith("\\")) {
      const escaped = atom[1];
      return atom.length === 2
          && escaped !== undefined
          && !/[A-Za-z0-9]/u.test(escaped)
        ? escaped
        : undefined;
    }
    const character = String.fromCodePoint(atom.codePointAt(0) ?? 0);
    return character.length === atom.length
        && !/[\\^$.*+?()[\]{}|]/u.test(character)
      ? character
      : undefined;
  };

  if (!source.startsWith("[")) {
    const character = parseLiteralAtom({ atom: source });
    return character === undefined ? undefined : [character];
  }
  if (
    findJqCharacterClassEnd({ source, startIndex: 0 }) !== source.length - 1
    || source[1] === "^"
  ) return undefined;

  const characters: string[] = [];
  for (let index = 1; index < source.length - 1;) {
    const endIndex = source[index] === "\\"
      ? findJqEscapeEnd({ source, startIndex: index })
      : index + String.fromCodePoint(source.codePointAt(index) ?? 0).length - 1;
    const atom = source.slice(index, endIndex + 1);
    const character = parseLiteralAtom({ atom });
    if (
      character === undefined
      || character === "-"
      || characters.length
        >= JQ_MAX_QUANTIFIED_BACKREFERENCE_FINITE_CLASS_CODE_POINTS
    ) return undefined;
    characters.push(character);
    index = endIndex + 1;
  }
  return characters.length === 0 ? undefined : characters;
}

// Positive-variable replay can retain width-changing full folds, but only when
// every simple-case spelling has the same jq backreference semantics at both
// terminal and nonterminal input positions. This rejects compatibility folds
// such as Kelvin sign and long-s without excluding measured full folds such as
// sharp-s and ligatures.
function jqPositiveVariableBackreferenceTargetHasStableFiniteCaseFold({
  source,
}: {
  source: string;
}): boolean {
  const characters = jqQuantifiedBackreferenceTargetFiniteCharacters({ source });
  return characters !== undefined && characters.every(
    character => jqSimpleCaseFoldCharactersHaveEquivalentBackreferenceSemantics({
      character,
    }),
  );
}

function jqMinimumTwoBackreferenceTargetHasStableCaseFold({
  source,
  allowMultipleCaseFoldEquivalenceClasses,
}: {
  source: string;
  allowMultipleCaseFoldEquivalenceClasses: boolean;
}): boolean {
  const characters = jqQuantifiedBackreferenceTargetFiniteCharacters({ source });
  if (characters === undefined) return false;
  const representative = characters[0];
  if (representative === undefined) return false;
  for (const character of characters) {
    // Greedy and lazy references may split a later sibling-alternative
    // character from an older capture-history branch. The bounded state does
    // not represent that overlap, so those quantifiers admit one jq case-fold
    // equivalence class only. Possessive references commit their repetitions
    // before the sibling branch and may use the full bounded finite set.
    if (
      !allowMultipleCaseFoldEquivalenceClasses
      && (
        !jqCaseInsensitiveBackreferenceCharactersEqual({
          left: representative,
          right: character,
          hasInputSuffix: false,
        })
        || !jqCaseInsensitiveBackreferenceCharactersEqual({
          left: representative,
          right: character,
          hasInputSuffix: true,
        })
      )
    ) return false;
    for (const variant of [
      character.toUpperCase(),
      character.toLowerCase(),
      character.toLocaleUpperCase("und"),
      character.toLocaleLowerCase("und"),
    ]) {
      // Multi-code-point folds multiply the bounded history state and were an
      // order of magnitude slower for minimum-two references. Keep them on the
      // established native path even when their small semantic corpus agrees.
      if ([...variant].length !== 1) return false;
      if (
        !jqCaseInsensitiveBackreferenceCharactersEqual({
          left: character,
          right: variant,
          hasInputSuffix: false,
        })
        || !jqCaseInsensitiveBackreferenceCharactersEqual({
          left: character,
          right: variant,
          hasInputSuffix: true,
        })
      ) return false;
    }
  }
  return true;
}

// The bounded fallback is sound only for the narrow capture shapes exercised
// by the differential proof: an optional direct capture containing up to
// alternatives whose atoms and separators fit the existing 41-token budget,
// with at most six simple single-code-point atoms per alternative, or that
// capture at the end of an optional noncapturing wrapper after one to six
// simple prefix atoms, followed by an unconditional absolute numeric reference
// or an unambiguous named reference. Duplicate-name, relative, longer or nested
// alternatives, separated or fixed-width quantified references, and variable-
// or zero-width prefix escape forms remain on the conservative native path.
// Whole-pattern case-insensitive references may use a positive variable
// quantifier for one pre-fold capture atom. A zero-minimum quantifier uses the
// same structural proof only when longest matching resolves the empty branch.
function requiredSimpleBackreferenceTargetIndexes({
  source,
  startIndex,
  endIndex,
  groups,
  groupEndIndexes,
  simpleAtomsPrevalidated,
  allowPositiveVariableBackreferenceQuantifier,
  allowMinimumTwoVariableBackreferenceQuantifier,
  allowZeroMinimumBackreferenceQuantifier,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
  groups: readonly JqCapturingGroupDescriptor[];
  groupEndIndexes: ReadonlyMap<number, number>;
  simpleAtomsPrevalidated: boolean;
  allowPositiveVariableBackreferenceQuantifier: boolean;
  allowMinimumTwoVariableBackreferenceQuantifier: boolean;
  allowZeroMinimumBackreferenceQuantifier: boolean;
}): readonly number[] | undefined {
  const targetLogicalIndexes: number[] = [];
  let found = false;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] !== "\\") continue;
    const backreference = parseJqRegularExpressionBackreference({
      source,
      startIndex: index,
    });
    if (backreference === undefined) {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    const backreferenceQuantifier = parseJqBackreferenceQuantifier({
      source,
      startIndex: backreference.endIndex + 1,
    });
    const zeroMinimumBackreferenceQuantifier =
      backreferenceQuantifier?.minimumRepetitions === 0;
    if (backreferenceQuantifier !== undefined) {
      const quantifiedBackreferenceIsCompatible =
        backreferenceQuantifier.minimumRepetitions === 0
          ? allowZeroMinimumBackreferenceQuantifier
          : backreferenceQuantifier.minimumRepetitions === 1
            ? backreferenceQuantifier.maximumRepetitions !== 1
              && allowPositiveVariableBackreferenceQuantifier
            : backreferenceQuantifier.maximumRepetitions
              !== backreferenceQuantifier.minimumRepetitions
              && allowMinimumTwoVariableBackreferenceQuantifier
              && (
                backreferenceQuantifier.endIndex === endIndex
                || source[backreferenceQuantifier.endIndex] === "|"
              );
      if (!quantifiedBackreferenceIsCompatible) return undefined;
    }
    const target = (() => {
      if (/^[1-9]\d*$/u.test(backreference.reference)) {
        return groups[Number.parseInt(backreference.reference, 10) - 1];
      }
      if (/^-\d+$/u.test(backreference.reference)) return undefined;
      const namedTargets = groups.filter((group) =>
        group.name === backreference.reference && group.startIndex < index
      );
      return namedTargets.length === 1 ? namedTargets[0] : undefined;
    })();
    if (
      target === undefined
      || target.startIndex < startIndex
      || target.endIndex >= endIndex
      || (
        target.name !== null
        && groups.some((group) =>
          group.logicalIndex !== target.logicalIndex && group.name === target.name
        )
      )
    ) return undefined;
    if (
      source[target.endIndex + 1] !== "?"
      || source[target.endIndex + 2] === "?"
      || source[target.endIndex + 2] === "+"
    ) return undefined;
    const targetSource = source.slice(target.contentStartIndex, target.endIndex);
    if (
      !simpleAtomsPrevalidated
      && backreferenceQuantifier?.minimumRepetitions === 1
      && !jqPositiveVariableBackreferenceTargetHasStableFiniteCaseFold({
        source: targetSource,
      })
    ) return undefined;
    if (
      backreferenceQuantifier !== undefined
      && backreferenceQuantifier.minimumRepetitions >= 2
      && !jqMinimumTwoBackreferenceTargetHasStableCaseFold({
        source: targetSource,
        allowMultipleCaseFoldEquivalenceClasses:
          backreferenceQuantifier.possessive,
      })
    ) return undefined;
    // A matching pre-fold group signature already proved the original target
    // against the simple atom and token budgets. Full Unicode case-folding may
    // only have expanded those atoms into controlled noncapturing alternatives.
    const targetIsSimpleBoundedCapture = simpleAtomsPrevalidated
      ? true
      : backreferenceQuantifier === undefined
        ? isJqSimpleBoundedCaptureExpression({ source: targetSource })
        : jqSimpleBoundedCaptureAlternativeAtomCount({
          source: targetSource,
          maximumAtomCount: 1,
        }) === 1;
    if (!targetIsSimpleBoundedCapture) return undefined;
    const enclosingGroups = [...groupEndIndexes.entries()].filter(
      ([groupStartIndex, groupEndIndex]) =>
        groupStartIndex >= startIndex
        && groupStartIndex < target.startIndex
        && groupEndIndex > target.endIndex
        && groupEndIndex <= endIndex,
    );
    if (index === target.endIndex + 2) {
      if (enclosingGroups.length !== 0) return undefined;
    } else {
      if (zeroMinimumBackreferenceQuantifier) return undefined;
      if (enclosingGroups.length !== 1) return undefined;
      const [wrapperStartIndex, wrapperEndIndex] = enclosingGroups[0]!;
      const wrapper = parseJqGroupPrefix({ source, startIndex: wrapperStartIndex });
      if (
        wrapper?.prefix !== "(?:"
        || target.endIndex + 2 !== wrapperEndIndex
        || source[wrapperEndIndex + 1] !== "?"
        || index !== wrapperEndIndex + 2
      ) return undefined;
      const prefixSource = source.slice(wrapper.contentStart, target.startIndex);
      // The pre-fold signature similarly proves the original wrapper prefix;
      // case-fold expansion may vary its width but cannot add arbitrary syntax.
      const prefixIsSimpleBoundedSequence = simpleAtomsPrevalidated
        ? true
        : isJqSimpleBoundedCaptureAlternative({
          source: prefixSource,
          maximumAtomCount:
            JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_PREFIX_CODE_POINTS,
        });
      if (!prefixIsSimpleBoundedSequence) return undefined;
      if (groups.some((group) =>
        group.logicalIndex !== target.logicalIndex
        && group.startIndex > wrapperStartIndex
        && group.endIndex < wrapperEndIndex
      )) return undefined;
    }
    found = true;
    targetLogicalIndexes.push(target.logicalIndex);
    index = backreference.endIndex;
  }
  return found ? targetLogicalIndexes : undefined;
}


function simpleCaptureHistoryGroupSignature({
  groups,
  groupStartIndex,
  groupEndIndex,
  targetLogicalIndexes,
}: {
  groups: readonly JqCapturingGroupDescriptor[];
  groupStartIndex: number;
  groupEndIndex: number;
  targetLogicalIndexes: readonly number[];
}): string {
  const containedLogicalIndexes = groups
    .filter((group) =>
      group.startIndex >= groupStartIndex && group.endIndex <= groupEndIndex
    )
    .map((group) => group.logicalIndex);
  return `${containedLogicalIndexes.join(",")}|${targetLogicalIndexes.join(",")}`;
}

function collectSimpleCaptureHistoryGroupSignatures({
  source,
  allowPositiveVariableBackreferenceQuantifier,
  allowMinimumTwoVariableBackreferenceQuantifier,
  allowZeroMinimumBackreferenceQuantifier,
}: {
  source: string;
  allowPositiveVariableBackreferenceQuantifier: boolean;
  allowMinimumTwoVariableBackreferenceQuantifier: boolean;
  allowZeroMinimumBackreferenceQuantifier: boolean;
}): ReadonlySet<string> {
  const groups = collectJqCapturingGroups({ source });
  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  const signatures = new Set<string>();
  for (const [groupStartIndex, groupEndIndex] of groupEndIndexes) {
    const quantifier = parseJqCaptureHistoryGroupQuantifier({
      source,
      startIndex: groupEndIndex + 1,
    });
    if (
      quantifier?.maximumRepetitions !== null
      || !quantifier.greedy
    ) {
      continue;
    }
    const groupContentStart = parseJqGroupPrefix({
      source,
      startIndex: groupStartIndex,
    })?.contentStart ?? groupEndIndex;
    if (!jqExpressionCanMatchEmpty({
      source,
      startIndex: groupContentStart,
      endIndex: groupEndIndex,
      groupEndIndexes,
    })) {
      continue;
    }
    const targetLogicalIndexes = requiredSimpleBackreferenceTargetIndexes({
      source,
      startIndex: groupContentStart,
      endIndex: groupEndIndex,
      groups,
      groupEndIndexes,
      simpleAtomsPrevalidated: false,
      allowPositiveVariableBackreferenceQuantifier,
      allowMinimumTwoVariableBackreferenceQuantifier,
      allowZeroMinimumBackreferenceQuantifier,
    });
    if (targetLogicalIndexes === undefined) continue;
    signatures.add(simpleCaptureHistoryGroupSignature({
      groups,
      groupStartIndex,
      groupEndIndex,
      targetLogicalIndexes,
    }));
  }
  return signatures;
}

function isJqDirectOptionalBackreferenceHistoryAlternative({
  source,
}: {
  source: string;
}): boolean {
  const groups = collectJqCapturingGroups({ source });
  if (groups.length !== 1) return false;
  const target = groups[0]!;
  if (target.startIndex !== 0 || source[target.endIndex + 1] !== "?") {
    return false;
  }

  if (
    jqQuantifiedBackreferenceTargetFiniteCharacters({
      source: source.slice(target.contentStartIndex, target.endIndex),
    })?.length !== 1
  ) return false;

  const backreference = parseJqRegularExpressionBackreference({
    source,
    startIndex: target.endIndex + 2,
  });
  if (backreference === undefined) return false;
  const targetReference = target.name ?? String(target.logicalIndex + 1);
  if (backreference.reference !== targetReference) return false;

  const quantifier = parseJqBackreferenceQuantifier({
    source,
    startIndex: backreference.endIndex + 1,
  });
  return quantifier?.minimumRepetitions === 0
    && quantifier.maximumRepetitions === 1
    && quantifier.greedy
    && !quantifier.possessive
    && quantifier.endIndex === source.length;
}

function isJqLongestWholeMatchGuardedOptionalBackreferenceHistoryAlternative({
  source,
}: {
  source: string;
}): boolean {
  const groups = collectJqCapturingGroups({ source });
  if (groups.length !== 1) return false;
  const target = groups[0]!;
  if (target.startIndex !== 0 || source[target.endIndex + 1] !== "?") {
    return false;
  }

  const targetSource = source.slice(target.contentStartIndex, target.endIndex);
  // Unicode property classes have measured capture-history differences even
  // when the bounded and native whole-match spans agree. Keep them on the
  // native path; the longest replay proof covers the remaining simple atoms.
  if (/\\[pP]\{/u.test(targetSource)) return false;
  const alternatives = splitTopLevelAlternatives({ source: targetSource });
  if (
    alternatives.length === 0
    || alternatives.length > 2
    || alternatives.some((alternative) =>
      jqSimpleBoundedCaptureAlternativeAtomCount({
        source: alternative,
        maximumAtomCount: 2,
      }) === undefined
    )
    || alternatives.reduce((sum, alternative) =>
      sum + (jqSimpleBoundedCaptureAlternativeAtomCount({
        source: alternative,
        maximumAtomCount: 2,
      }) ?? 0), 0) > 2
  ) return false;

  const backreference = parseJqRegularExpressionBackreference({
    source,
    startIndex: target.endIndex + 2,
  });
  if (backreference === undefined) return false;
  const targetReference = target.name ?? String(target.logicalIndex + 1);
  if (backreference.reference !== targetReference) return false;

  const quantifier = parseJqBackreferenceQuantifier({
    source,
    startIndex: backreference.endIndex + 1,
  });
  return quantifier?.minimumRepetitions === 0
    && quantifier.maximumRepetitions === 1
    && quantifier.greedy
    && !quantifier.possessive
    && quantifier.endIndex === source.length;
}

function isJqTerminalOptionalCaptureHistorySiblingAlternative({
  source,
}: {
  source: string;
}): boolean {
  const directCharacters = jqQuantifiedBackreferenceTargetFiniteCharacters({
    source,
  });
  if (directCharacters?.length === 1) return true;

  const groups = collectJqCapturingGroups({ source });
  if (groups.length !== 1) return false;
  const group = groups[0]!;
  if (group.startIndex !== 0 || group.endIndex !== source.length - 1) {
    return false;
  }
  return jqQuantifiedBackreferenceTargetFiniteCharacters({
    source: source.slice(group.contentStartIndex, group.endIndex),
  })?.length === 1;
}

function isJqTerminalOptionalCaptureHistoryDeadSiblingAlternative({
  source,
}: {
  source: string;
}): boolean {
  if (!source.startsWith("(?:") || !source.endsWith("(?!))")) return false;
  return isJqTerminalOptionalCaptureHistorySiblingAlternative({
    source: source.slice(3, -5),
  });
}

function isJqTerminalOptionalCaptureHistoryProjectionReplayContent({
  source,
}: {
  source: string;
}): boolean {
  const alternatives = splitTopLevelAlternatives({ source });
  const firstAlternative = alternatives[0];
  if (firstAlternative === undefined) return false;
  const firstAlternativeGroups = collectJqCapturingGroups({
    source: firstAlternative,
  });
  return alternatives.length >= 2
    && firstAlternativeGroups.length === 1
    && firstAlternativeGroups[0]!.name === null
    && isJqDirectOptionalBackreferenceHistoryAlternative({
      source: firstAlternative,
    })
    && alternatives.slice(1).every((alternative) =>
      isJqTerminalOptionalCaptureHistoryDeadSiblingAlternative({
        source: alternative,
      })
    );
}

function isJqWholeMatchGuardedOptionalCaptureHistoryProjectionReplayContent({
  source,
  longest,
}: {
  source: string;
  longest: boolean;
}): boolean {
  const alternatives = splitTopLevelAlternatives({ source });
  const firstAlternative = alternatives[0];
  return firstAlternative !== undefined
    && alternatives.length >= 2
    && (longest
      ? isJqLongestWholeMatchGuardedOptionalBackreferenceHistoryAlternative({
        source: firstAlternative,
      })
      : isJqDirectOptionalBackreferenceHistoryAlternative({
        source: firstAlternative,
      }))
    && alternatives.slice(1).every((alternative) =>
      isJqTerminalOptionalCaptureHistorySiblingAlternative({
        source: alternative,
      })
    );
}

function rewriteJqTerminalOptionalCaptureHistoryGroup({
  source,
  groupStartIndex,
  groupEndIndex,
  quantifier,
}: {
  source: string;
  groupStartIndex: number;
  groupEndIndex: number;
  quantifier: JqCaptureHistoryGroupQuantifier;
}): string {
  const group = parseJqGroupPrefix({ source, startIndex: groupStartIndex });
  if (
    group?.prefix !== "(?:"
    || quantifier.minimumRepetitions !== 0
    || quantifier.maximumRepetitions !== null
    || !quantifier.greedy
    || source.slice(groupEndIndex + 1, quantifier.endIndex) !== "*"
  ) return source;

  const content = source.slice(group.contentStart, groupEndIndex);
  const alternatives = splitTopLevelAlternatives({ source: content });
  if (
    alternatives.length < 2
    || !isJqDirectOptionalBackreferenceHistoryAlternative({
      source: alternatives[0]!,
    })
    || alternatives.slice(1).some((alternative) =>
      !isJqTerminalOptionalCaptureHistorySiblingAlternative({
        source: alternative,
      })
    )
  ) return source;

  const rewrittenContent = [
    alternatives[0]!,
    ...alternatives.slice(1).map((alternative) =>
      `(?:${alternative}(?!))`
    ),
  ].join("|");
  return source.slice(0, group.contentStart)
    + rewrittenContent
    + source.slice(groupEndIndex);
}

function rewriteJqTerminalOptionalCaptureHistoryAlternative({
  source,
  depth,
}: {
  source: string;
  depth: number;
}): string {
  if (depth >= JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH) return source;
  const groupEndIndexes = mapJqGroupEndIndexes({ source });

  for (const [groupStartIndex, groupEndIndex] of groupEndIndexes) {
    const quantifier = parseJqCaptureHistoryGroupQuantifier({
      source,
      startIndex: groupEndIndex + 1,
    });
    if (quantifier?.endIndex !== source.length) continue;
    return rewriteJqTerminalOptionalCaptureHistoryGroup({
      source,
      groupStartIndex,
      groupEndIndex,
      quantifier,
    });
  }

  const terminalGroup = [...groupEndIndexes.entries()].find(
    ([, groupEndIndex]) => groupEndIndex === source.length - 1,
  );
  if (terminalGroup === undefined) return source;
  const [groupStartIndex, groupEndIndex] = terminalGroup;
  const group = parseJqGroupPrefix({ source, startIndex: groupStartIndex });
  if (group?.prefix !== "(?:") return source;

  const content = source.slice(group.contentStart, groupEndIndex);
  const rewrittenContent = rewriteJqTerminalOptionalCaptureHistoryBranchesAtDepth({
    source: content,
    depth: depth + 1,
  });
  if (rewrittenContent === content) return source;
  return source.slice(0, group.contentStart)
    + rewrittenContent
    + source.slice(groupEndIndex);
}

function rewriteJqTerminalOptionalCaptureHistoryBranchesAtDepth({
  source,
  depth,
}: {
  source: string;
  depth: number;
}): string {
  if (depth >= JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH) return source;
  return splitTopLevelAlternatives({ source })
    .map((alternative) => rewriteJqTerminalOptionalCaptureHistoryAlternative({
      source: alternative,
      depth,
    }))
    .join("|");
}

function rewriteJqTerminalOptionalCaptureHistoryBranches({
  source,
}: {
  source: string;
}): string {
  return rewriteJqTerminalOptionalCaptureHistoryBranchesAtDepth({
    source,
    depth: 0,
  });
}

function collectSingletonRequiredSevenCodePointCaptureHistoryGroupSignatures({
  source,
}: {
  source: string;
}): ReadonlySet<string> {
  const groups = collectJqCapturingGroups({ source });
  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  const signatures = new Set<string>();

  for (const [groupStartIndex, groupEndIndex] of groupEndIndexes) {
    const quantifier = parseJqCaptureHistoryGroupQuantifier({
      source,
      startIndex: groupEndIndex + 1,
    });
    if (
      quantifier?.maximumRepetitions !== null
      || !quantifier.greedy
    ) continue;

    const groupContentStart = parseJqGroupPrefix({
      source,
      startIndex: groupStartIndex,
    })?.contentStart ?? groupEndIndex;
    if (!jqExpressionCanMatchEmpty({
      source,
      startIndex: groupContentStart,
      endIndex: groupEndIndex,
      groupEndIndexes,
    })) continue;

    const targetLogicalIndexes = requiredSimpleBackreferenceTargetIndexes({
      source,
      startIndex: groupContentStart,
      endIndex: groupEndIndex,
      groups,
      groupEndIndexes,
      simpleAtomsPrevalidated: false,
      allowPositiveVariableBackreferenceQuantifier: false,
      allowMinimumTwoVariableBackreferenceQuantifier: false,
      allowZeroMinimumBackreferenceQuantifier: false,
    });
    if (targetLogicalIndexes?.length !== 1) continue;

    const target = groups[targetLogicalIndexes[0]!];
    if (
      target === undefined
      || target.startIndex !== groupContentStart
      || groups.filter((group) =>
        group.startIndex >= groupStartIndex && group.endIndex <= groupEndIndex
      ).length !== 1
    ) continue;

    const targetCharacters = jqQuantifiedBackreferenceTargetFiniteCharacters({
      source: source.slice(target.contentStartIndex, target.endIndex),
    });
    if (targetCharacters?.length !== 1) continue;

    // This seven-code-point proof covers only the exact greedy `?` target
    // quantifier. Keep the structural assumption explicit instead of relying
    // on the following backreference parse to reject every other quantifier.
    if (source[target.endIndex + 1] !== "?") continue;
    const backreferenceStartIndex = target.endIndex + 2;
    const backreference = parseJqRegularExpressionBackreference({
      source,
      startIndex: backreferenceStartIndex,
    });
    if (
      backreference === undefined
      || parseJqBackreferenceQuantifier({
        source,
        startIndex: backreference.endIndex + 1,
      }) !== undefined
      || source[backreference.endIndex + 1] !== "|"
    ) continue;

    const siblingCharacters = jqQuantifiedBackreferenceTargetFiniteCharacters({
      source: source.slice(backreference.endIndex + 2, groupEndIndex),
    });
    if (siblingCharacters?.length !== 1) continue;

    signatures.add(simpleCaptureHistoryGroupSignature({
      groups,
      groupStartIndex,
      groupEndIndex,
      targetLogicalIndexes,
    }));
  }

  return signatures;
}

const JQ_LOCAL_CASE_FOLDED_BACKREFERENCE_MARKER_PREFIX =
  "(?<jqInternalLocalCaseFoldBackreference";

function extractJqLocalCaseFoldedBackreferenceMarkers({
  source,
}: {
  source: string;
}): {
  readonly source: string;
  readonly backreferenceStartIndexes: ReadonlySet<number>;
} {
  const parts: string[] = [];
  const backreferenceStartIndexes = new Set<number>();
  let emittedLength = 0;

  for (let index = 0; index < source.length;) {
    if (source.startsWith(
      JQ_LOCAL_CASE_FOLDED_BACKREFERENCE_MARKER_PREFIX,
      index,
    )) {
      const marker = /^\(\?<jqInternalLocalCaseFoldBackreference\d+>\)/u.exec(
        source.slice(index),
      );
      if (marker !== null) {
        const backreferenceStartIndex = index + marker[0].length;
        const backreference = parseJqRegularExpressionBackreference({
          source,
          startIndex: backreferenceStartIndex,
        });
        if (backreference !== undefined) {
          backreferenceStartIndexes.add(emittedLength);
          index = backreferenceStartIndex;
          continue;
        }
      }
    }
    const character = String.fromCodePoint(source.codePointAt(index)!);
    parts.push(character);
    emittedLength += character.length;
    index += character.length;
  }

  return {
    source: parts.join(""),
    backreferenceStartIndexes,
  };
}

interface JqBackreferenceQuantifier {
  readonly endIndex: number;
  readonly minimumRepetitions: number;
  readonly maximumRepetitions: number | null;
  readonly greedy: boolean;
  readonly possessive: boolean;
}

function parseJqBackreferenceQuantifier({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): JqBackreferenceQuantifier | undefined {
  const match = /^(?:([?*+])|\{(\d+)(?:,(\d*))?\})([?+]?)/u.exec(
    source.slice(startIndex),
  );
  if (match === null) return undefined;

  let minimumRepetitions: number;
  let maximumRepetitions: number | null;
  switch (match[1]) {
  case "?":
    minimumRepetitions = 0;
    maximumRepetitions = 1;
    break;
  case "*":
    minimumRepetitions = 0;
    maximumRepetitions = null;
    break;
  case "+":
    minimumRepetitions = 1;
    maximumRepetitions = null;
    break;
  default:
    minimumRepetitions = Number.parseInt(match[2]!, 10);
    maximumRepetitions = match[3] === undefined
      ? minimumRepetitions
      : match[3].length === 0
        ? null
        : Number.parseInt(match[3], 10);
  }
  return {
    endIndex: startIndex + match[0].length,
    minimumRepetitions,
    maximumRepetitions,
    greedy: match[4] !== "?",
    possessive: match[4] === "+",
  };
}

interface JqCaptureHistoryGroupQuantifier {
  readonly endIndex: number;
  readonly minimumRepetitions: number;
  readonly maximumRepetitions: number | null;
  readonly greedy: boolean;
}

function parseJqCaptureHistoryGroupQuantifier({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): JqCaptureHistoryGroupQuantifier | undefined {
  const simple = /^([*+])([?+]?)/u.exec(source.slice(startIndex));
  if (simple !== null) {
    if (simple[2] === "+") return undefined;
    return {
      endIndex: startIndex + simple[0].length,
      minimumRepetitions: simple[1] === "+" ? 1 : 0,
      maximumRepetitions: null,
      greedy: simple[2] !== "?",
    };
  }

  const bounded = /^\{(\d+)(?:,(\d*))?\}([?+]?)/u.exec(
    source.slice(startIndex),
  );
  if (bounded === null || bounded[3] === "+") return undefined;
  const minimumRepetitions = Number.parseInt(bounded[1]!, 10);
  const maximumRepetitions = bounded[2] === undefined
    ? minimumRepetitions
    : bounded[2].length === 0
      ? null
      : Number.parseInt(bounded[2], 10);
  if (
    maximumRepetitions !== null
    && (
      maximumRepetitions < minimumRepetitions
      || maximumRepetitions > JQ_MAX_BOUNDED_CAPTURE_HISTORY_REPETITIONS
    )
  ) return undefined;
  return {
    endIndex: startIndex + bounded[0].length,
    minimumRepetitions,
    maximumRepetitions,
    greedy: bounded[3] !== "?",
  };
}

interface JqProgressQuantifier {
  readonly endIndex: number;
  readonly minimumRepetitions: number;
  readonly maximumRepetitions: number | null;
}

function parseJqProgressQuantifier({
  source,
  startIndex,
  endIndex,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
}): JqProgressQuantifier | undefined {
  const match = /^(?:([?*+])|\{(\d+)(?:,(\d*))?\})(?:[?+]?)/u.exec(
    source.slice(startIndex, endIndex),
  );
  if (match === null) return undefined;

  let minimumRepetitions: number;
  let maximumRepetitions: number | null;
  switch (match[1]) {
  case "?":
    minimumRepetitions = 0;
    maximumRepetitions = 1;
    break;
  case "*":
    minimumRepetitions = 0;
    maximumRepetitions = null;
    break;
  case "+":
    minimumRepetitions = 1;
    maximumRepetitions = null;
    break;
  default:
    minimumRepetitions = Number.parseInt(match[2]!, 10);
    maximumRepetitions = match[3] === undefined
      ? minimumRepetitions
      : match[3].length === 0
        ? null
        : Number.parseInt(match[3], 10);
  }

  return {
    endIndex: startIndex + match[0].length,
    minimumRepetitions,
    maximumRepetitions,
  };
}

function jqExpressionRangeFixedCodePointLength({
  source,
  startIndex,
  endIndex,
  groupEndIndexes,
  groupFixedCodePointLengths,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
  groupEndIndexes: ReadonlyMap<number, number>;
  groupFixedCodePointLengths: ReadonlyMap<number, number | undefined>;
}): number | undefined {
  const sequenceFixedLength = ({
    sequenceStart,
    sequenceEnd,
  }: {
    sequenceStart: number;
    sequenceEnd: number;
  }): number | undefined => {
    let length = 0;
    let index = sequenceStart;
    while (index < sequenceEnd) {
      const character = source[index]!;
      let atomEnd = index + 1;
      let atomLength: number | undefined;
      if (character === "\\") {
        const call = parseJqSubexpressionCall({ source, startIndex: index });
        const backreference = parseJqRegularExpressionBackreference({
          source,
          startIndex: index,
        });
        atomEnd = Math.min(
          findJqEscapeEnd({ source, startIndex: index }) + 1,
          sequenceEnd,
        );
        if (call !== undefined || backreference !== undefined) return undefined;
        const escaped = source[index + 1];
        if (
          escaped === "A"
          || escaped === "b"
          || escaped === "B"
          || escaped === "G"
          || escaped === "K"
          || escaped === "y"
          || escaped === "Y"
          || escaped === "z"
          || escaped === "Z"
        ) {
          atomLength = 0;
        } else if (
          escaped !== undefined
          && !/[A-Za-z0-9]/u.test(escaped)
        ) {
          atomLength = 1;
        } else {
          return undefined;
        }
      } else if (character === "[") {
        atomEnd = Math.min(
          findJqCharacterClassEnd({ source, startIndex: index }) + 1,
          sequenceEnd,
        );
        atomLength = 1;
      } else if (character === "(") {
        const groupEndIndex = groupEndIndexes.get(index);
        const group = parseJqGroupPrefix({ source, startIndex: index });
        if (
          groupEndIndex === undefined
          || groupEndIndex >= sequenceEnd
          || group === undefined
        ) return undefined;
        atomEnd = groupEndIndex + 1;
        atomLength = group.prefix === "(?="
          || group.prefix === "(?!"
          || group.prefix === "(?<="
          || group.prefix === "(?<!"
          ? 0
          : groupFixedCodePointLengths.get(index);
        if (atomLength === undefined) return undefined;
      } else if (character === "^" || character === "$") {
        atomLength = 0;
      } else {
        const codePoint = source.codePointAt(index);
        if (codePoint === undefined) return undefined;
        atomEnd = index + (codePoint > 0xffff ? 2 : 1);
        atomLength = 1;
      }

      const quantifier = parseJqProgressQuantifier({
        source,
        startIndex: atomEnd,
        endIndex: sequenceEnd,
      });
      if (quantifier !== undefined) {
        if (atomLength !== 0) {
          if (
            quantifier.maximumRepetitions === null
            || quantifier.minimumRepetitions !== quantifier.maximumRepetitions
          ) return undefined;
          atomLength *= quantifier.minimumRepetitions;
        }
        atomEnd = quantifier.endIndex;
      }
      length += atomLength;
      index = atomEnd;
    }
    return length;
  };

  let fixedLength: number | undefined;
  let alternativeStart = startIndex;
  let index = startIndex;
  while (index <= endIndex) {
    if (index === endIndex || source[index] === "|") {
      const alternativeLength = sequenceFixedLength({
        sequenceStart: alternativeStart,
        sequenceEnd: index,
      });
      if (alternativeLength === undefined) return undefined;
      if (fixedLength === undefined) fixedLength = alternativeLength;
      else if (fixedLength !== alternativeLength) return undefined;
      alternativeStart = index + 1;
      index += 1;
      continue;
    }
    if (source[index] === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "(") {
      const groupEndIndex = groupEndIndexes.get(index);
      if (groupEndIndex === undefined || groupEndIndex >= endIndex) {
        return undefined;
      }
      index = groupEndIndex + 1;
      continue;
    }
    const codePoint = source.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }
  return fixedLength;
}

function jqLogicalCaptureFixedCodePointLengths({
  source,
  groups,
  groupEndIndexes,
}: {
  source: string;
  groups: readonly JqCapturingGroupDescriptor[];
  groupEndIndexes: ReadonlyMap<number, number>;
}): readonly (number | undefined)[] {
  const groupFixedCodePointLengths = new Map<number, number | undefined>();
  const groupStartIndexes = [...groupEndIndexes.keys()].toSorted(
    (left, right) => right - left,
  );
  for (const groupStartIndex of groupStartIndexes) {
    const groupEndIndex = groupEndIndexes.get(groupStartIndex);
    const group = parseJqGroupPrefix({ source, startIndex: groupStartIndex });
    groupFixedCodePointLengths.set(
      groupStartIndex,
      groupEndIndex === undefined || group === undefined
        ? undefined
        : jqExpressionRangeFixedCodePointLength({
          source,
          startIndex: group.contentStart,
          endIndex: groupEndIndex,
          groupEndIndexes,
          groupFixedCodePointLengths,
        }),
    );
  }
  return groups.map((group) =>
    groupFixedCodePointLengths.get(group.startIndex),
  );
}

function jqCaseFoldedCaptureCandidateSource({
  source,
  group,
  groupEndIndexes,
}: {
  source: string;
  group: JqCapturingGroupDescriptor;
  groupEndIndexes: ReadonlyMap<number, number>;
}): string | undefined {
  const rewriteRange = ({
    startIndex,
    endIndex,
  }: {
    startIndex: number;
    endIndex: number;
  }): string | undefined => {
    const parts: string[] = [];
    for (let index = startIndex; index < endIndex;) {
      const character = source[index]!;
      if (character === "\\") {
        if (
          parseJqSubexpressionCall({ source, startIndex: index }) !== undefined
          || parseJqRegularExpressionBackreference({
            source,
            startIndex: index,
          }) !== undefined
        ) return undefined;
        const escaped = source[index + 1];
        if (
          escaped === "A"
          || escaped === "b"
          || escaped === "B"
          || escaped === "G"
          || escaped === "K"
          || escaped === "y"
          || escaped === "Y"
          || escaped === "z"
          || escaped === "Z"
        ) return undefined;
        if (escaped === undefined || /[A-Za-z0-9]/u.test(escaped)) {
          return undefined;
        }
        const escapeEnd = findJqEscapeEnd({ source, startIndex: index });
        if (escapeEnd >= endIndex) return undefined;
        parts.push(source.slice(index, escapeEnd + 1));
        index = escapeEnd + 1;
        continue;
      }
      if (character === "[") {
        const classEnd = findJqCharacterClassEnd({ source, startIndex: index });
        if (classEnd >= endIndex) return undefined;
        const characterClass = source.slice(index, classEnd + 1);
        if (characterClass.includes("\\")) return undefined;
        parts.push(characterClass);
        index = classEnd + 1;
        continue;
      }
      if (character === "(") {
        const groupEndIndex = groupEndIndexes.get(index);
        const nested = parseJqGroupPrefix({ source, startIndex: index });
        if (
          groupEndIndex === undefined
          || groupEndIndex >= endIndex
          || nested === undefined
          || nested.prefix === "(?="
          || nested.prefix === "(?!"
          || nested.prefix === "(?<="
          || nested.prefix === "(?<!"
        ) return undefined;
        const rewritten = rewriteRange({
          startIndex: nested.contentStart,
          endIndex: groupEndIndex,
        });
        if (rewritten === undefined) return undefined;
        parts.push("(?:", rewritten, ")");
        index = groupEndIndex + 1;
        continue;
      }
      if (character === "^" || character === "$") return undefined;
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined) return undefined;
      const width = codePoint > 0xffff ? 2 : 1;
      parts.push(source.slice(index, index + width));
      index += width;
    }
    return parts.join("");
  };

  const candidate = rewriteRange({
    startIndex: group.contentStartIndex,
    endIndex: group.endIndex,
  });
  if (candidate === undefined) return undefined;
  try {
    const translated = translateJqLocalModifierSegment({
      source: candidate,
      initialState: {
        ignoreCase: true,
        multilineAnchors: false,
        dotAll: true,
        extendedMode: false,
      },
      insideGroup: false,
    });
    new RegExp(`(?:${translated})`, "u");
    return translated;
  } catch {
    return undefined;
  }
}

function repeatJqCaseFoldedCaptureCandidateSource({
  source,
  minimumRepetitions,
  maximumRepetitions,
  greedy,
}: {
  source: string;
  minimumRepetitions: number;
  maximumRepetitions: number | null;
  greedy: boolean;
}): string {
  if (minimumRepetitions === 1 && maximumRepetitions === 1) {
    return `(?:${source})`;
  }
  let quantifier: string;
  if (minimumRepetitions === 0 && maximumRepetitions === 1) quantifier = "?";
  else if (minimumRepetitions === 0 && maximumRepetitions === null) {
    quantifier = "*";
  } else if (minimumRepetitions === 1 && maximumRepetitions === null) {
    quantifier = "+";
  } else if (minimumRepetitions === maximumRepetitions) {
    quantifier = `{${minimumRepetitions}}`;
  } else if (maximumRepetitions === null) {
    quantifier = `{${minimumRepetitions},}`;
  } else {
    quantifier = `{${minimumRepetitions},${maximumRepetitions}}`;
  }
  return `(?:${source})${quantifier}${greedy ? "" : "?"}`;
}

function jqExpressionRangeCanMatchEmpty({
  source,
  startIndex,
  endIndex,
  groups,
  groupEndIndexes,
  groupCanMatchEmpty,
  logicalCaptureCanMatchEmpty,
  resolveCallLogicalIndex,
  resolveBackreferenceLogicalIndexes,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
  groups: readonly JqCapturingGroupDescriptor[];
  groupEndIndexes: ReadonlyMap<number, number>;
  groupCanMatchEmpty: ReadonlyMap<number, boolean>;
  logicalCaptureCanMatchEmpty: readonly boolean[];
  resolveCallLogicalIndex: ({
    call,
    callStartIndex,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
  }) => number;
  resolveBackreferenceLogicalIndexes: ({
    backreference,
    backreferenceStartIndex,
  }: {
    backreference: JqRegularExpressionBackreference;
    backreferenceStartIndex: number;
  }) => readonly number[];
}): boolean {
  const sequenceCanMatchEmpty = ({
    sequenceStart,
    sequenceEnd,
  }: {
    sequenceStart: number;
    sequenceEnd: number;
  }): boolean => {
    let index = sequenceStart;
    while (index < sequenceEnd) {
      const character = source[index]!;
      let atomEnd = index + 1;
      let atomCanMatchEmpty: boolean;
      if (character === "\\") {
        const call = parseJqSubexpressionCall({ source, startIndex: index });
        if (call !== undefined) {
          atomEnd = call.endIndex + 1;
          atomCanMatchEmpty = logicalCaptureCanMatchEmpty[
            resolveCallLogicalIndex({ call, callStartIndex: index })
          ] ?? true;
        } else {
          const backreference = parseJqRegularExpressionBackreference({
            source,
            startIndex: index,
          });
          if (backreference !== undefined) {
            atomEnd = backreference.endIndex + 1;
            const targetLogicalIndexes = resolveBackreferenceLogicalIndexes({
              backreference,
              backreferenceStartIndex: index,
            });
            atomCanMatchEmpty = targetLogicalIndexes.some((logicalIndex) => {
              const target = groups[logicalIndex];
              return target === undefined
                || target.endIndex >= index
                || (logicalCaptureCanMatchEmpty[logicalIndex] ?? true);
            });
          } else {
            const escaped = source[index + 1];
            atomEnd = Math.min(
              findJqEscapeEnd({ source, startIndex: index }) + 1,
              sequenceEnd,
            );
            atomCanMatchEmpty = escaped === "A"
              || escaped === "b"
              || escaped === "B"
              || escaped === "G"
              || escaped === "K"
              || escaped === "y"
              || escaped === "Y"
              || escaped === "z"
              || escaped === "Z";
          }
        }
      } else if (character === "[") {
        atomEnd = Math.min(
          findJqCharacterClassEnd({ source, startIndex: index }) + 1,
          sequenceEnd,
        );
        atomCanMatchEmpty = false;
      } else if (character === "(") {
        const groupEndIndex = groupEndIndexes.get(index);
        const group = parseJqGroupPrefix({ source, startIndex: index });
        if (
          groupEndIndex === undefined
          || groupEndIndex >= sequenceEnd
          || group === undefined
        ) return true;
        atomEnd = groupEndIndex + 1;
        atomCanMatchEmpty = group.prefix === "(?="
          || group.prefix === "(?!"
          || group.prefix === "(?<="
          || group.prefix === "(?<!"
          || (groupCanMatchEmpty.get(index) ?? true);
      } else if (character === "^" || character === "$") {
        atomCanMatchEmpty = true;
      } else {
        atomCanMatchEmpty = false;
      }

      const quantifier = parseJqProgressQuantifier({
        source,
        startIndex: atomEnd,
        endIndex: sequenceEnd,
      });
      if (
        quantifier?.minimumRepetitions === 0
        || quantifier?.maximumRepetitions === 0
      ) atomCanMatchEmpty = true;
      if (!atomCanMatchEmpty) return false;
      index = quantifier?.endIndex ?? atomEnd;
    }
    return true;
  };

  let alternativeStart = startIndex;
  let index = startIndex;
  while (index <= endIndex) {
    if (index === endIndex || source[index] === "|") {
      if (sequenceCanMatchEmpty({
        sequenceStart: alternativeStart,
        sequenceEnd: index,
      })) return true;
      alternativeStart = index + 1;
      index += 1;
      continue;
    }
    if (source[index] === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "(") {
      const groupEndIndex = groupEndIndexes.get(index);
      if (groupEndIndex === undefined || groupEndIndex >= endIndex) return true;
      index = groupEndIndex + 1;
      continue;
    }
    index += 1;
  }
  return false;
}

function validateJqSubexpressionCallProgress({
  source,
  groups,
  groupEndIndexes,
  resolveCallLogicalIndex,
  resolveBackreferenceLogicalIndexes,
}: {
  source: string;
  groups: readonly JqCapturingGroupDescriptor[];
  groupEndIndexes: ReadonlyMap<number, number>;
  resolveCallLogicalIndex: ({
    call,
    callStartIndex,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
  }) => number;
  resolveBackreferenceLogicalIndexes: ({
    backreference,
    backreferenceStartIndex,
  }: {
    backreference: JqRegularExpressionBackreference;
    backreferenceStartIndex: number;
  }) => readonly number[];
}): void {
  if (groups.length === 0) return;

  const groupStartIndexes = [...groupEndIndexes.keys()].toSorted(
    (left, right) => right - left,
  );
  const computeGroupNullability = ({
    logicalCaptureCanMatchEmpty,
  }: {
    logicalCaptureCanMatchEmpty: readonly boolean[];
  }): ReadonlyMap<number, boolean> => {
    const groupCanMatchEmpty = new Map<number, boolean>();
    for (const groupStartIndex of groupStartIndexes) {
      const groupEndIndex = groupEndIndexes.get(groupStartIndex);
      const group = parseJqGroupPrefix({
        source,
        startIndex: groupStartIndex,
      });
      if (groupEndIndex === undefined || group === undefined) {
        groupCanMatchEmpty.set(groupStartIndex, true);
        continue;
      }
      groupCanMatchEmpty.set(
        groupStartIndex,
        jqExpressionRangeCanMatchEmpty({
          source,
          startIndex: group.contentStart,
          endIndex: groupEndIndex,
          groups,
          groupEndIndexes,
          groupCanMatchEmpty,
          logicalCaptureCanMatchEmpty,
          resolveCallLogicalIndex,
          resolveBackreferenceLogicalIndexes,
        }),
      );
    }
    return groupCanMatchEmpty;
  };

  let logicalCaptureCanMatchEmpty = groups.map(() => false);
  let groupCanMatchEmpty = computeGroupNullability({
    logicalCaptureCanMatchEmpty,
  });
  for (let iteration = 0; iteration <= groups.length; iteration += 1) {
    const nextLogicalCaptureCanMatchEmpty = groups.map(
      (group) => groupCanMatchEmpty.get(group.startIndex) ?? true,
    );
    if (nextLogicalCaptureCanMatchEmpty.every(
      (value, logicalIndex) =>
        value === logicalCaptureCanMatchEmpty[logicalIndex],
    )) {
      logicalCaptureCanMatchEmpty = nextLogicalCaptureCanMatchEmpty;
      break;
    }
    logicalCaptureCanMatchEmpty = nextLogicalCaptureCanMatchEmpty;
    groupCanMatchEmpty = computeGroupNullability({
      logicalCaptureCanMatchEmpty,
    });
  }

  const zeroConsumptionEdges = groups.map(() => new Set<number>());
  const pending: {
    readonly ownerLogicalIndex: number;
    readonly startIndex: number;
    readonly endIndex: number;
  }[] = groups.map((group) => ({
    ownerLogicalIndex: group.logicalIndex,
    startIndex: group.contentStartIndex,
    endIndex: group.endIndex,
  }));

  while (pending.length !== 0) {
    const task = pending.pop()!;
    let alternativeStart = task.startIndex;
    let scanIndex = task.startIndex;
    const alternatives: { readonly startIndex: number; readonly endIndex: number }[] = [];
    while (scanIndex <= task.endIndex) {
      if (scanIndex === task.endIndex || source[scanIndex] === "|") {
        alternatives.push({ startIndex: alternativeStart, endIndex: scanIndex });
        alternativeStart = scanIndex + 1;
        scanIndex += 1;
        continue;
      }
      if (source[scanIndex] === "\\") {
        scanIndex = findJqEscapeEnd({ source, startIndex: scanIndex }) + 1;
        continue;
      }
      if (source[scanIndex] === "[") {
        scanIndex = findJqCharacterClassEnd({
          source,
          startIndex: scanIndex,
        }) + 1;
        continue;
      }
      if (source[scanIndex] === "(") {
        const groupEndIndex = groupEndIndexes.get(scanIndex);
        if (groupEndIndex === undefined || groupEndIndex >= task.endIndex) break;
        scanIndex = groupEndIndex + 1;
        continue;
      }
      scanIndex += 1;
    }

    for (const alternative of alternatives) {
      let prefixCanMatchEmpty = true;
      let index = alternative.startIndex;
      while (index < alternative.endIndex) {
        const character = source[index]!;
        let atomEnd = index + 1;
        let atomCanMatchEmpty: boolean;
        let callTargetLogicalIndex: number | undefined;
        let nestedGroupContent:
          | { readonly startIndex: number; readonly endIndex: number }
          | undefined;

        if (character === "\\") {
          const call = parseJqSubexpressionCall({ source, startIndex: index });
          if (call !== undefined) {
            atomEnd = call.endIndex + 1;
            callTargetLogicalIndex = resolveCallLogicalIndex({
              call,
              callStartIndex: index,
            });
            atomCanMatchEmpty = logicalCaptureCanMatchEmpty[
              callTargetLogicalIndex
            ] ?? true;
          } else {
            const backreference = parseJqRegularExpressionBackreference({
              source,
              startIndex: index,
            });
            if (backreference !== undefined) {
              atomEnd = backreference.endIndex + 1;
              const targetLogicalIndexes = resolveBackreferenceLogicalIndexes({
                backreference,
                backreferenceStartIndex: index,
              });
              atomCanMatchEmpty = targetLogicalIndexes.some((logicalIndex) => {
                const target = groups[logicalIndex];
                return target === undefined
                  || target.endIndex >= index
                  || (logicalCaptureCanMatchEmpty[logicalIndex] ?? true);
              });
            } else {
              const escaped = source[index + 1];
              atomEnd = Math.min(
                findJqEscapeEnd({ source, startIndex: index }) + 1,
                alternative.endIndex,
              );
              atomCanMatchEmpty = escaped === "A"
                || escaped === "b"
                || escaped === "B"
                || escaped === "G"
                || escaped === "K"
                || escaped === "y"
                || escaped === "Y"
                || escaped === "z"
                || escaped === "Z";
            }
          }
        } else if (character === "[") {
          atomEnd = Math.min(
            findJqCharacterClassEnd({ source, startIndex: index }) + 1,
            alternative.endIndex,
          );
          atomCanMatchEmpty = false;
        } else if (character === "(") {
          const groupEndIndex = groupEndIndexes.get(index);
          const group = parseJqGroupPrefix({ source, startIndex: index });
          if (
            groupEndIndex === undefined
            || groupEndIndex >= alternative.endIndex
            || group === undefined
          ) break;
          atomEnd = groupEndIndex + 1;
          nestedGroupContent = {
            startIndex: group.contentStart,
            endIndex: groupEndIndex,
          };
          atomCanMatchEmpty = group.prefix === "(?="
            || group.prefix === "(?!"
            || group.prefix === "(?<="
            || group.prefix === "(?<!"
            || (groupCanMatchEmpty.get(index) ?? true);
        } else if (character === "^" || character === "$") {
          atomCanMatchEmpty = true;
        } else {
          atomCanMatchEmpty = false;
        }

        const quantifier = parseJqProgressQuantifier({
          source,
          startIndex: atomEnd,
          endIndex: alternative.endIndex,
        });
        const maximumRepetitions = quantifier?.maximumRepetitions ?? 1;
        if (prefixCanMatchEmpty && maximumRepetitions !== 0) {
          if (callTargetLogicalIndex !== undefined) {
            zeroConsumptionEdges[task.ownerLogicalIndex]!.add(
              callTargetLogicalIndex,
            );
          }
          if (nestedGroupContent !== undefined) {
            pending.push({
              ownerLogicalIndex: task.ownerLogicalIndex,
              ...nestedGroupContent,
            });
          }
        }
        if (
          quantifier?.minimumRepetitions === 0
          || maximumRepetitions === 0
        ) atomCanMatchEmpty = true;
        prefixCanMatchEmpty = prefixCanMatchEmpty && atomCanMatchEmpty;
        index = quantifier?.endIndex ?? atomEnd;
      }
    }
  }

  const incomingEdgeCounts = groups.map(() => 0);
  for (const targets of zeroConsumptionEdges) {
    for (const target of targets) {
      incomingEdgeCounts[target] = (incomingEdgeCounts[target] ?? 0) + 1;
    }
  }
  const ready = incomingEdgeCounts
    .map((count, logicalIndex) => ({ count, logicalIndex }))
    .filter(({ count }) => count === 0)
    .map(({ logicalIndex }) => logicalIndex);
  let visitedCount = 0;
  while (ready.length !== 0) {
    const logicalIndex = ready.pop()!;
    visitedCount += 1;
    for (const target of zeroConsumptionEdges[logicalIndex]!) {
      const nextCount = (incomingEdgeCounts[target] ?? 0) - 1;
      incomingEdgeCounts[target] = nextCount;
      if (nextCount === 0) ready.push(target);
    }
  }
  if (visitedCount !== groups.length) {
    throw new JqNeverEndingRecursionError("never ending recursion");
  }
}

function jqExpressionCanMatchEmpty({
  source,
  startIndex,
  endIndex,
  groupEndIndexes,
  subexpressionCallCanMatchEmpty,
}: {
  source: string;
  startIndex: number;
  endIndex: number;
  groupEndIndexes: ReadonlyMap<number, number>;
  subexpressionCallCanMatchEmpty?: ({
    call,
    callStartIndex,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
  }) => boolean;
}): boolean {
  const sequenceCanMatchEmpty = ({
    sequenceStart,
    sequenceEnd,
  }: {
    sequenceStart: number;
    sequenceEnd: number;
  }): boolean => {
    let index = sequenceStart;
    while (index < sequenceEnd) {
      const character = source[index]!;
      let atomEnd = index + 1;
      let atomCanMatchEmpty: boolean;
      if (character === "\\") {
        const escaped = source[index + 1];
        atomEnd = Math.min(
          findJqEscapeEnd({ source, startIndex: index }) + 1,
          sequenceEnd,
        );
        const subexpressionCall = parseJqSubexpressionCall({
          source,
          startIndex: index,
        });
        atomCanMatchEmpty = subexpressionCall !== undefined
          ? subexpressionCallCanMatchEmpty?.({
            call: subexpressionCall,
            callStartIndex: index,
          }) ?? true
          : escaped === "A"
            || escaped === "b"
            || escaped === "B"
            || escaped === "G"
            || escaped === "K"
            || escaped === "y"
            || escaped === "Y"
            || escaped === "z"
            || escaped === "Z"
            || escaped === "k"
            || (escaped !== undefined && /[1-9]/u.test(escaped));
      } else if (character === "[") {
        atomEnd = Math.min(
          findJqCharacterClassEnd({ source, startIndex: index }) + 1,
          sequenceEnd,
        );
        atomCanMatchEmpty = false;
      } else if (character === "(") {
        const groupEndIndex = groupEndIndexes.get(index);
        const group = parseJqGroupPrefix({ source, startIndex: index });
        if (
          groupEndIndex === undefined
          || groupEndIndex >= sequenceEnd
          || group === undefined
        ) return true;
        atomEnd = groupEndIndex + 1;
        atomCanMatchEmpty = group.prefix === "(?="
          || group.prefix === "(?!"
          || group.prefix === "(?<="
          || group.prefix === "(?<!"
          || jqExpressionCanMatchEmpty({
            source,
            startIndex: group.contentStart,
            endIndex: groupEndIndex,
            groupEndIndexes,
            subexpressionCallCanMatchEmpty,
          });
      } else if (character === "^" || character === "$") {
        atomCanMatchEmpty = true;
      } else {
        atomCanMatchEmpty = false;
      }

      const quantifier = /^([?*+]|\{(\d+)(?:,\d*)?\})(?:[?+]?)/u.exec(
        source.slice(atomEnd, sequenceEnd),
      );
      if (quantifier !== null) {
        const minimum = quantifier[1] === "?" || quantifier[1] === "*"
          ? 0
          : quantifier[1] === "+"
            ? 1
            : Number.parseInt(quantifier[2]!, 10);
        if (minimum === 0) atomCanMatchEmpty = true;
        atomEnd += quantifier[0].length;
      }
      if (!atomCanMatchEmpty) return false;
      index = atomEnd;
    }
    return true;
  };

  let alternativeStart = startIndex;
  let index = startIndex;
  while (index <= endIndex) {
    if (index === endIndex || source[index] === "|") {
      if (sequenceCanMatchEmpty({
        sequenceStart: alternativeStart,
        sequenceEnd: index,
      })) return true;
      alternativeStart = index + 1;
      index += 1;
      continue;
    }
    if (source[index] === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index }) + 1;
      continue;
    }
    if (source[index] === "(") {
      const groupEndIndex = groupEndIndexes.get(index);
      if (groupEndIndex === undefined || groupEndIndex >= endIndex) return true;
      index = groupEndIndex + 1;
      continue;
    }
    index += 1;
  }
  return false;
}

function jqExpressionCanMatchEmptyAtAnyPosition({
  source,
}: {
  source: string;
}): boolean {
  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (character === "\\") {
      if (parseJqSubexpressionCall({ source, startIndex: index }) !== undefined) {
        return false;
      }
      const escaped = source[index + 1];
      if (
        escaped === "A" ||
        escaped === "b" ||
        escaped === "B" ||
        escaped === "G" ||
        escaped === "K" ||
        escaped === "y" ||
        escaped === "Y" ||
        escaped === "z" ||
        escaped === "Z"
      ) {
        return false;
      }
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === "^" || character === "$") return false;
    if (character !== "(") continue;
    const group = parseJqGroupPrefix({ source, startIndex: index });
    if (
      group?.prefix === "(?=" ||
      group?.prefix === "(?!" ||
      group?.prefix === "(?<=" ||
      group?.prefix === "(?<!"
    ) {
      return false;
    }
  }
  return jqExpressionCanMatchEmpty({
    source,
    startIndex: 0,
    endIndex: source.length,
    groupEndIndexes,
  });
}

function countJqRegularExpressionAlternations({
  source,
}: {
  source: string;
}): number {
  let count = 0;
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (!inBracket && character === "|") count += 1;
  }
  return count;
}

function expandJqSubexpressionCalls({
  source: rawSource,
  caseFoldAllBackreferences,
  longest,
  nullableUnboundedSimpleCaptureHistoryMaximum,
  plainUnboundedCaptureHistoryMaximum,
  linearRuntimeUnboundedCaptureHistoryMaximum,
  relaxedSimpleCaptureHistoryGroupSignatures,
  allowWholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
  maximumEmittedLength,
}: {
  source: string;
  caseFoldAllBackreferences: boolean;
  longest: boolean;
  nullableUnboundedSimpleCaptureHistoryMaximum?: number;
  plainUnboundedCaptureHistoryMaximum?: number;
  linearRuntimeUnboundedCaptureHistoryMaximum?: number;
  relaxedSimpleCaptureHistoryGroupSignatures: ReadonlySet<string>;
  allowWholeMatchGuardedOptionalCaptureHistoryProjectionReplay: boolean;
  maximumEmittedLength?: number;
}): {
  readonly source: string;
  readonly captureNames: readonly (string | null)[];
  readonly captureSlots: readonly (number | undefined)[];
  readonly backreferenceAlternatives: readonly {
    readonly id: number;
    readonly markerCaptureIndex: number;
    readonly targetCaptureIndex: number;
    readonly newerTargetCaptureIndexes: readonly number[];
    readonly comparison: "exact" | "case-folded";
    readonly minimumRepetitions: number;
    readonly maximumRepetitions: number | null;
    readonly greedy: boolean;
    readonly possessive: boolean;
    readonly initialCaseFoldedCodePointLengthConstraint:
      | JqCaseFoldedBackreferenceLengthConstraint
      | undefined;
    readonly initialCaseFoldedCandidateSource: string | undefined;
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  readonly positionAssertions: readonly {
    readonly markerCaptureIndex: number;
    readonly kind: "boundary" | "non-boundary" | "search-start";
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  readonly recursiveCaptureLogicalIndexes: readonly number[];
  readonly subexpressionCallExpansionAdditionalAlternationCount: number;
  readonly hasNullableUnboundedSimpleCaptureHistory: boolean;
  readonly hasTerminalOptionalCaptureHistoryProjectionReplay: boolean;
  readonly hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay: boolean;
  readonly plainUnboundedCaptureHistoryGroupCount: number;
  readonly linearRuntimeUnboundedCaptureHistoryGroupCount: number;
} {
  const localCaseFoldedBackreferences =
    extractJqLocalCaseFoldedBackreferenceMarkers({ source: rawSource });
  const source = localCaseFoldedBackreferences.source;
  const caseFoldedBackreferenceStartIndexes =
    localCaseFoldedBackreferences.backreferenceStartIndexes;
  const hasBackreferences = containsJqRegularExpressionBackreference({ source });
  const calls: {
    readonly startIndex: number;
    readonly call: JqSubexpressionCall;
  }[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (source[index] !== "\\") continue;
    const call = parseJqSubexpressionCall({ source, startIndex: index });
    if (call !== undefined) {
      calls.push({ startIndex: index, call });
      index = call.endIndex;
      continue;
    }
    index = findJqEscapeEnd({ source, startIndex: index });
  }
  const groups = collectJqCapturingGroups({ source });
  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  let logicalCaptureFixedCodePointLengths:
    | readonly (number | undefined)[]
    | undefined;
  const caseFoldedCandidateSources = new Map<number, string | undefined>();
  const fixedCodePointLength = ({
    logicalIndex,
  }: {
    logicalIndex: number;
  }): number | undefined => {
    logicalCaptureFixedCodePointLengths ??=
      jqLogicalCaptureFixedCodePointLengths({
        source,
        groups,
        groupEndIndexes,
      });
    return logicalCaptureFixedCodePointLengths[logicalIndex];
  };
  const caseFoldedCandidateSource = ({
    logicalIndex,
  }: {
    logicalIndex: number;
  }): string | undefined => {
    if (caseFoldedCandidateSources.has(logicalIndex)) {
      return caseFoldedCandidateSources.get(logicalIndex);
    }
    const group = groups[logicalIndex];
    const candidate = group === undefined
      ? undefined
      : jqCaseFoldedCaptureCandidateSource({
        source,
        group,
        groupEndIndexes,
      });
    caseFoldedCandidateSources.set(logicalIndex, candidate);
    return candidate;
  };
  const captureNames = groups.map((group) => group.name);
  const rewritesBackreferences = hasBackreferences;

  const groupByStart = new Map(groups.map((group) => [group.startIndex, group]));
  const groupsByName = new Map<string, JqCapturingGroupDescriptor[]>();
  for (const group of groups) {
    if (group.name === null) continue;
    const named = groupsByName.get(group.name) ?? [];
    named.push(group);
    groupsByName.set(group.name, named);
  }
  const groupStartIndexes = groups.map((group) => group.startIndex);
  const captureSlots: (number | undefined)[] = [];
  const backreferenceAlternatives: {
    readonly id: number;
    readonly markerCaptureIndex: number;
    readonly targetCaptureIndex: number;
    readonly newerTargetCaptureIndexes: readonly number[];
    readonly comparison: "exact" | "case-folded";
    readonly minimumRepetitions: number;
    readonly maximumRepetitions: number | null;
    readonly greedy: boolean;
    readonly possessive: boolean;
    readonly initialCaseFoldedCodePointLengthConstraint:
      | JqCaseFoldedBackreferenceLengthConstraint
      | undefined;
    readonly initialCaseFoldedCandidateSource: string | undefined;
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[] = [];
  const positionAssertions: {
    readonly markerCaptureIndex: number;
    readonly kind: "boundary" | "non-boundary" | "search-start";
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[] = [];
  const recursiveCaptureLogicalIndexes = new Set<number>();
  const fullyBoundedNullableHistoryGroupStartIndexes = new Set<number>();
  const fullyBoundedPlainHistoryGroupStartIndexes = new Set<number>();
  const fullyBoundedLinearRuntimeHistoryGroupStartIndexes = new Set<number>();
  let hasNullableUnboundedSimpleCaptureHistory = false;
  let hasTerminalOptionalCaptureHistoryProjectionReplay = false;
  let hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay = false;
  let plainUnboundedCaptureHistoryGroupCount = 0;
  let linearRuntimeUnboundedCaptureHistoryGroupCount = 0;
  let emittedLength = 0;
  const append = ({ parts, value }: { parts: string[]; value: string }): void => {
    emittedLength += value.length;
    if (
      maximumEmittedLength !== undefined
      && emittedLength > maximumEmittedLength
    ) {
      throw new JqRegularExpressionSourceBudgetError();
    }
    if (emittedLength > 1_000_000) {
      throw new Error("expanded subexpression call exceeds the safe size limit");
    }
    parts.push(value);
  };

  const countCapturesBefore = ({ sourceIndex }: { sourceIndex: number }): number => {
    let lower = 0;
    let upper = groupStartIndexes.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (groupStartIndexes[middle]! < sourceIndex) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };

  const resolveReference = ({
    reference,
    referenceStartIndex,
    description,
  }: {
    reference: string;
    referenceStartIndex: number;
    description: "backreference" | "subexpression call";
  }): JqCapturingGroupDescriptor => {
    if (/^-\d+$/u.test(reference)) {
      const capturesBefore = countCapturesBefore({ sourceIndex: referenceStartIndex });
      const logicalIndex = capturesBefore + Number.parseInt(reference, 10);
      const group = groups[logicalIndex];
      if (group === undefined) {
        throw new Error(`invalid relative ${description}`);
      }
      return group;
    }
    if (/^[1-9]\d*$/u.test(reference)) {
      const group = groups[Number.parseInt(reference, 10) - 1];
      if (group === undefined) throw new Error(`invalid ${description}`);
      return group;
    }
    const named = groupsByName.get(reference);
    if (named === undefined || named.length === 0) {
      throw new Error(`undefined ${description} '${reference}'`);
    }
    if (named.length !== 1) {
      switch (description) {
      case "subexpression call":
        throw new Error(`multiplex definition name <${reference}> call`);
      case "backreference":
        throw new Error(
          `duplicate named ${description} '${reference}' is unsupported`,
        );
      default: {
        const _ex: never = description;
        throw new Error(`Unhandled regular expression reference: ${_ex}`);
      }
      }
    }
    return named[0]!;
  };

  const resolveCall = ({
    call,
    callStartIndex,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
  }): JqCapturingGroupDescriptor =>
    resolveReference({
      reference: call.reference,
      referenceStartIndex: callStartIndex,
      description: "subexpression call",
    });

  const subexpressionCallCanMatchEmptyInternal = ({
    call,
    callStartIndex,
    activeLogicalIndexes,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
    activeLogicalIndexes: ReadonlySet<number>;
  }): boolean => {
    const target = resolveCall({ call, callStartIndex });
    if (
      activeLogicalIndexes.has(target.logicalIndex)
      || activeLogicalIndexes.size >= JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH
    ) return true;
    const nextActiveLogicalIndexes = new Set(activeLogicalIndexes);
    nextActiveLogicalIndexes.add(target.logicalIndex);
    return jqExpressionCanMatchEmpty({
      source,
      startIndex: target.contentStartIndex,
      endIndex: target.endIndex,
      groupEndIndexes,
      subexpressionCallCanMatchEmpty: ({
        call: nestedCall,
        callStartIndex: nestedCallStartIndex,
      }) => subexpressionCallCanMatchEmptyInternal({
        call: nestedCall,
        callStartIndex: nestedCallStartIndex,
        activeLogicalIndexes: nextActiveLogicalIndexes,
      }),
    });
  };

  const subexpressionCallCanMatchEmpty = ({
    call,
    callStartIndex,
  }: {
    call: JqSubexpressionCall;
    callStartIndex: number;
  }): boolean => subexpressionCallCanMatchEmptyInternal({
    call,
    callStartIndex,
    activeLogicalIndexes: new Set<number>(),
  });

  const resolveBackreferenceLogicalIndexes = ({
    backreference,
    backreferenceStartIndex,
  }: {
    backreference: JqRegularExpressionBackreference;
    backreferenceStartIndex: number;
  }): readonly number[] => {
    const reference = backreference.reference;
    if (/^-\d+$/u.test(reference)) {
      return [resolveReference({
        reference,
        referenceStartIndex: backreferenceStartIndex,
        description: "backreference",
      }).logicalIndex];
    }
    if (/^[1-9]\d*$/u.test(reference)) {
      const logicalIndex = Number.parseInt(reference, 10) - 1;
      return groups[logicalIndex] === undefined ? [] : [logicalIndex];
    }
    const named = groupsByName.get(reference)?.filter(
      (group) => group.startIndex < backreferenceStartIndex,
    );
    if (named === undefined || named.length === 0) {
      throw new JqRegularExpressionFailureError(
        `undefined name <${reference}> reference`,
      );
    }
    return named.map((group) => group.logicalIndex);
  };

  const resolveBackreferenceTargets = ({
    backreference,
    backreferenceStartIndex,
  }: {
    backreference: JqRegularExpressionBackreference;
    backreferenceStartIndex: number;
  }): readonly JqCapturingGroupDescriptor[] =>
    resolveBackreferenceLogicalIndexes({
      backreference,
      backreferenceStartIndex,
    }).map((logicalIndex) => groups[logicalIndex]!);


  const segmentUsesLinearRuntimeCandidates = ({
    startIndex,
    endIndex,
    activeCalls,
    depth,
  }: {
    startIndex: number;
    endIndex: number;
    activeCalls: ReadonlySet<number>;
    depth: number;
  }): boolean => {
    if (depth > JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH) return false;
    for (let index = startIndex; index < endIndex; index += 1) {
      const character = source[index]!;
      if (character === "[") {
        index = Math.min(
          findJqCharacterClassEnd({ source, startIndex: index }),
          endIndex - 1,
        );
        continue;
      }
      if (character !== "\\") continue;

      const call = parseJqSubexpressionCall({ source, startIndex: index });
      if (call !== undefined) {
        const target = resolveCall({ call, callStartIndex: index });
        if (activeCalls.has(target.logicalIndex)) return false;
        const nextActiveCalls = new Set(activeCalls);
        nextActiveCalls.add(target.logicalIndex);
        if (!segmentUsesLinearRuntimeCandidates({
          startIndex: target.contentStartIndex,
          endIndex: target.endIndex,
          activeCalls: nextActiveCalls,
          depth: depth + 1,
        })) return false;
        index = call.endIndex;
        continue;
      }

      const backreference = parseJqRegularExpressionBackreference({
        source,
        startIndex: index,
      });
      if (backreference !== undefined) {
        const targets = resolveBackreferenceTargets({
          backreference,
          backreferenceStartIndex: index,
        });
        if (
          targets.length !== 1 ||
          !jqCaptureDefinitelyParticipatesBeforeBackreference({
            source,
            target: targets[0]!,
            backreferenceStartIndex: index,
            segmentStartIndex: startIndex,
            segmentEndIndex: endIndex,
            groupEndIndexes,
          })
        ) return false;
        index = backreference.endIndex;
        continue;
      }

      const positionOperator = source[index + 1];
      if (
        positionOperator === "y" ||
        positionOperator === "Y" ||
        positionOperator === "G"
      ) return false;
      index = Math.min(
        findJqEscapeEnd({ source, startIndex: index }),
        endIndex - 1,
      );
    }
    return true;
  };

  if (calls.length !== 0) {
    validateJqSubexpressionCallProgress({
      source,
      groups,
      groupEndIndexes,
      resolveCallLogicalIndex: ({ call, callStartIndex }) =>
        resolveCall({ call, callStartIndex }).logicalIndex,
      resolveBackreferenceLogicalIndexes,
    });
  }

  const physicalCapturesByLogicalIndex: number[][] = [];
  const openCapture = ({
    logicalIndex,
    originalPrefix,
    recursiveProjection,
  }: {
    logicalIndex: number;
    originalPrefix: string;
    recursiveProjection: boolean;
  }): string => {
    captureSlots.push(logicalIndex);
    const physicalIndex = captureSlots.length;
    const physicalCaptures = physicalCapturesByLogicalIndex[logicalIndex] ?? [];
    physicalCaptures.push(physicalIndex);
    physicalCapturesByLogicalIndex[logicalIndex] = physicalCaptures;
    if (recursiveProjection) recursiveCaptureLogicalIndexes.add(logicalIndex);
    if (!rewritesBackreferences) return originalPrefix;
    return "(";
  };

  const emitSegment = ({
    startIndex,
    endIndex,
    synthetic,
    activeCalls,
    depth,
    recursiveDepth,
  }: {
    startIndex: number;
    endIndex: number;
    synthetic: boolean;
    activeCalls: ReadonlySet<number>;
    depth: number;
    recursiveDepth: number;
  }): string => {
    if (depth > JQ_MAX_SUBEXPRESSION_CALL_EXPANSION_DEPTH) {
      throw new Error("subexpression call nesting exceeds the safe depth limit");
    }
    const physicalCaptureStartIndex = captureSlots.length;
    const parts: string[] = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const character = source[index]!;
      if (character === "(" && !synthetic) {
        const groupEndIndex = groupEndIndexes.get(index);
        const quantifier = groupEndIndex === undefined
          ? undefined
          : parseJqCaptureHistoryGroupQuantifier({
            source,
            startIndex: groupEndIndex + 1,
          });
        const hasCapture = groupEndIndex !== undefined && (
          groups.some((group) =>
            group.startIndex >= index && group.endIndex <= groupEndIndex
          )
          || calls.some(({ startIndex: callStartIndex }) =>
            callStartIndex > index && callStartIndex < groupEndIndex
          )
        );
        const unboundedHistoryPrefixRepetitions = (() => {
          if (
            quantifier?.maximumRepetitions !== null
            || !quantifier.greedy
            || groupEndIndex === undefined
          ) return undefined;
          const groupContentStart = parseJqGroupPrefix({
            source,
            startIndex: index,
          })?.contentStart ?? groupEndIndex;
          if (jqExpressionCanMatchEmpty({
            source,
            startIndex: groupContentStart,
            endIndex: groupEndIndex,
            groupEndIndexes,
            subexpressionCallCanMatchEmpty,
          })) {
            if (calls.some(({ startIndex: callStartIndex }) =>
              callStartIndex >= groupContentStart && callStartIndex < groupEndIndex
            )) return undefined;
            const strictFallbackTargetLogicalIndexes =
              requiredSimpleBackreferenceTargetIndexes({
                source,
                startIndex: groupContentStart,
                endIndex: groupEndIndex,
                groups,
                groupEndIndexes,
                simpleAtomsPrevalidated: false,
                allowPositiveVariableBackreferenceQuantifier: false,
                allowMinimumTwoVariableBackreferenceQuantifier: false,
                allowZeroMinimumBackreferenceQuantifier: false,
              });
            const fallbackTargetLogicalIndexes =
              strictFallbackTargetLogicalIndexes ?? (() => {
                if (
                  relaxedSimpleCaptureHistoryGroupSignatures.size === 0
                ) {
                  return undefined;
                }
                const relaxedTargetLogicalIndexes =
                  requiredSimpleBackreferenceTargetIndexes({
                    source,
                    startIndex: groupContentStart,
                    endIndex: groupEndIndex,
                    groups,
                    groupEndIndexes,
                    simpleAtomsPrevalidated: true,
                    allowPositiveVariableBackreferenceQuantifier: true,
                    allowMinimumTwoVariableBackreferenceQuantifier: true,
                    allowZeroMinimumBackreferenceQuantifier: true,
                  });
                if (relaxedTargetLogicalIndexes === undefined) return undefined;
                const signature = simpleCaptureHistoryGroupSignature({
                  groups,
                  groupStartIndex: index,
                  groupEndIndex,
                  targetLogicalIndexes: relaxedTargetLogicalIndexes,
                });
                return relaxedSimpleCaptureHistoryGroupSignatures.has(
                  signature,
                )
                  ? relaxedTargetLogicalIndexes
                  : undefined;
              })();
            // The terminal stop rewrite can make a sliced branch look like a
            // local `\1` history shape even when the full pattern's `\1`
            // actually targets an earlier capture. Match selection is already
            // fixed by the dead sibling; fully bounding only this short replay
            // preserves older physical capture slots for jq projection.
            const groupContent = source.slice(groupContentStart, groupEndIndex);
            const terminalProjectionReplay =
              fallbackTargetLogicalIndexes === undefined
              && countCapturesBefore({ sourceIndex: index }) > 0
              && isJqTerminalOptionalCaptureHistoryProjectionReplayContent({
                source: groupContent,
              });
            const wholeMatchGuardedProjectionReplay =
              allowWholeMatchGuardedOptionalCaptureHistoryProjectionReplay
              && fallbackTargetLogicalIndexes === undefined
              && isJqWholeMatchGuardedOptionalCaptureHistoryProjectionReplayContent({
                source: groupContent,
                longest,
              });
            if (
              !terminalProjectionReplay
              && !wholeMatchGuardedProjectionReplay
              && (
                fallbackTargetLogicalIndexes === undefined
                || (
                  strictFallbackTargetLogicalIndexes === undefined
                  && fallbackTargetLogicalIndexes.some((logicalIndex) => {
                    const length = fixedCodePointLength({ logicalIndex });
                    return length === undefined
                      ? caseFoldedCandidateSource({ logicalIndex }) === undefined
                      : length < 1 || length >
                        JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_ALTERNATIVE_CODE_POINTS;
                  })
                )
              )
            ) return undefined;
            hasNullableUnboundedSimpleCaptureHistory = true;
            hasTerminalOptionalCaptureHistoryProjectionReplay ||= terminalProjectionReplay;
            hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay ||=
              wholeMatchGuardedProjectionReplay;
            if (nullableUnboundedSimpleCaptureHistoryMaximum === undefined) {
              return undefined;
            }
            fullyBoundedNullableHistoryGroupStartIndexes.add(index);
            return nullableUnboundedSimpleCaptureHistoryMaximum;
          }
          const runtimeMarkerCount = countJqRuntimeValidationMarkers({
            source,
            startIndex: groupContentStart,
            endIndex: groupEndIndex,
          });
          const linearRuntimeCandidates = runtimeMarkerCount === 0 ||
            segmentUsesLinearRuntimeCandidates({
              startIndex: groupContentStart,
              endIndex: groupEndIndex,
              activeCalls: new Set<number>(),
              depth: 0,
            });
          if (runtimeMarkerCount === 0 && hasCapture) {
            plainUnboundedCaptureHistoryGroupCount += 1;
            if (plainUnboundedCaptureHistoryMaximum !== undefined) {
              fullyBoundedPlainHistoryGroupStartIndexes.add(index);
              return Math.max(
                quantifier.minimumRepetitions,
                plainUnboundedCaptureHistoryMaximum,
              );
            }
          } else if (
            runtimeMarkerCount > 0 &&
            hasCapture &&
            linearRuntimeCandidates
          ) {
            linearRuntimeUnboundedCaptureHistoryGroupCount += 1;
            if (linearRuntimeUnboundedCaptureHistoryMaximum !== undefined) {
              fullyBoundedLinearRuntimeHistoryGroupStartIndexes.add(index);
              return Math.max(
                quantifier.minimumRepetitions,
                linearRuntimeUnboundedCaptureHistoryMaximum,
              );
            }
          }
          const repetitions = unboundedCaptureHistoryPrefixRepetitions({
            runtimeMarkerCount,
            longest,
            linearRuntimeCandidates,
          });
          return quantifier.minimumRepetitions <= repetitions
            ? repetitions
            : undefined;
        })();
        const expandedMaximum = quantifier?.maximumRepetitions === null
          ? unboundedHistoryPrefixRepetitions
          : quantifier?.maximumRepetitions;
        if (
          groupEndIndex !== undefined
          && groupEndIndex < endIndex
          && quantifier !== undefined
          && quantifier.endIndex <= endIndex
          && hasCapture
          && expandedMaximum !== undefined
          && (
            quantifier.maximumRepetitions === null
              ? expandedMaximum >= 1
              : expandedMaximum > 1
          )
          && (
            quantifier.maximumRepetitions !== null
            || unboundedHistoryPrefixRepetitions !== undefined
          )
        ) {
          for (
            let repetition = 0;
            repetition < expandedMaximum;
            repetition += 1
          ) {
            const required = repetition < quantifier.minimumRepetitions;
            parts.push(emitSegment({
              startIndex: index,
              endIndex: groupEndIndex + 1,
              synthetic: true,
              activeCalls,
              depth: depth + 1,
              recursiveDepth,
            }));
            if (!required) {
              append({
                parts,
                value: quantifier.greedy ? "?" : "??",
              });
            }
          }
          if (
            quantifier.maximumRepetitions === null &&
            !fullyBoundedNullableHistoryGroupStartIndexes.has(index) &&
            !fullyBoundedPlainHistoryGroupStartIndexes.has(index) &&
            !fullyBoundedLinearRuntimeHistoryGroupStartIndexes.has(index)
          ) {
            parts.push(emitSegment({
              startIndex: index,
              endIndex: groupEndIndex + 1,
              synthetic: true,
              activeCalls,
              depth: depth + 1,
              recursiveDepth,
            }));
            append({ parts, value: "*" });
          }
          index = quantifier.endIndex - 1;
          continue;
        }
      }
      if (character === "\\") {
        const positionOperator = source[index + 1];
        if (
          positionOperator === "y" ||
          positionOperator === "Y" ||
          positionOperator === "G"
        ) {
          captureSlots.push(undefined);
          const markerCaptureIndex = captureSlots.length;
          append({
            parts,
            value: `(?<$p${markerCaptureIndex}>`,
          });
          const sourceStart = emittedLength;
          append({ parts, value: "(?=)" });
          const sourceEnd = emittedLength;
          append({ parts, value: ")" });
          positionAssertions.push({
            markerCaptureIndex,
            kind: (() => {
              switch (positionOperator) {
              case "y":
                return "boundary";
              case "Y":
                return "non-boundary";
              case "G":
                return "search-start";
              default: {
                const _ex: never = positionOperator;
                throw new Error(`Unhandled position operator: ${_ex}`);
              }
              }
            })(),
            sourceStart,
            sourceEnd,
          });
          index += 1;
          continue;
        }
        const call = parseJqSubexpressionCall({ source, startIndex: index });
        if (call !== undefined) {
          const callQuantifier = parseJqProgressQuantifier({
            source,
            startIndex: call.endIndex + 1,
            endIndex,
          });
          if (callQuantifier?.maximumRepetitions === 0) {
            append({ parts, value: "(?:)" });
            index = callQuantifier.endIndex - 1;
            continue;
          }
          const target = resolveCall({ call, callStartIndex: index });
          const recursive = activeCalls.has(target.logicalIndex);
          if (
            recursive &&
            recursiveDepth >= JQ_MAX_RECURSIVE_SUBEXPRESSION_CALL_DEPTH
          ) {
            append({ parts, value: "(?:(?!))" });
            index = call.endIndex;
            continue;
          }
          const nextActive = new Set(activeCalls);
          nextActive.add(target.logicalIndex);
          const nextRecursiveDepth = recursive
            ? recursiveDepth + 1
            : recursiveDepth;
          append({
            parts,
            value: openCapture({
              logicalIndex: target.logicalIndex,
              originalPrefix: "(",
              recursiveProjection: recursive || recursiveDepth > 0,
            }),
          });
          parts.push(
            emitSegment({
              startIndex: target.contentStartIndex,
              endIndex: target.endIndex,
              synthetic: true,
              activeCalls: nextActive,
              depth: depth + 1,
              recursiveDepth: nextRecursiveDepth,
            }),
          );
          append({ parts, value: ")" });
          index = call.endIndex;
          continue;
        }
        const backreference = parseJqRegularExpressionBackreference({
          source,
          startIndex: index,
        });
        if (backreference !== undefined && rewritesBackreferences) {
          if (/^[1-9]\d+$/u.test(backreference.reference)) {
            const groupNumber = Number.parseInt(backreference.reference, 10);
            if (groupNumber > groups.length) {
              const octal = /^[0-7]{1,3}/u.exec(backreference.reference)?.[0];
              if (octal !== undefined) {
                append({
                  parts,
                  value: encodeJqCodePointLiteral({
                    codePoint: Number.parseInt(octal, 8),
                  }),
                });
                index += octal.length;
                continue;
              }
            }
          }
          let targets: readonly JqCapturingGroupDescriptor[];
          try {
            targets = resolveBackreferenceTargets({
              backreference,
              backreferenceStartIndex: index,
            });
          } catch (error: unknown) {
            if (/^[1-9]\d*$/u.test(backreference.reference)) {
              append({ parts, value: "(?!)" });
              index = backreference.endIndex;
              continue;
            }
            throw error;
          }
          const allCandidates = targets
            .flatMap((target) =>
              (physicalCapturesByLogicalIndex[target.logicalIndex] ?? [])
                .map((physicalIndex) => ({
                  logicalIndex: target.logicalIndex,
                  physicalIndex,
                })),
            )
            .toSorted((left, right) =>
              right.physicalIndex - left.physicalIndex,
            );
          const mandatoryCurrentCandidate = targets.length === 1 && synthetic &&
            jqCaptureDefinitelyParticipatesBeforeBackreference({
              source,
              target: targets[0]!,
              backreferenceStartIndex: index,
              segmentStartIndex: startIndex,
              segmentEndIndex: endIndex,
              groupEndIndexes,
            })
            ? allCandidates.find((candidate) =>
              candidate.physicalIndex > physicalCaptureStartIndex
            )
            : undefined;
          const candidates = mandatoryCurrentCandidate === undefined
            ? allCandidates
            : [mandatoryCurrentCandidate];
          if (candidates.length === 0) {
            if (/^[1-9]\d*$/u.test(backreference.reference)) {
              append({ parts, value: "(?!)" });
              index = backreference.endIndex;
              continue;
            }
            throw new Error("forward backreferences are unsupported");
          }
          if (candidates.length > JQ_MAX_BACKREFERENCE_CAPTURE_ALTERNATIVES) {
            throw new Error(
              "backreference capture alternatives exceed the safe limit",
            );
          }
          const usesCaseFoldedComparison =
            caseFoldAllBackreferences ||
            caseFoldedBackreferenceStartIndexes.has(index);
          const comparison = usesCaseFoldedComparison
            ? "case-folded"
            : "exact";
          if (
            comparison === "exact"
            && mandatoryCurrentCandidate !== undefined
          ) {
            const numericBackreference =
              `\\${mandatoryCurrentCandidate.physicalIndex}`;
            append({
              parts,
              value: /^[0-9]/u.test(source[backreference.endIndex + 1] ?? "")
                ? `(?:${numericBackreference})`
                : numericBackreference,
            });
            index = backreference.endIndex;
            continue;
          }
          const quantifier = (() => {
            switch (comparison) {
            case "exact":
              return undefined;
            case "case-folded":
              return parseJqBackreferenceQuantifier({
                source,
                startIndex: backreference.endIndex + 1,
              });
            default: {
              const _ex: never = comparison;
              throw new Error(`Unhandled backreference comparison: ${_ex}`);
            }
            }
          })();
          const minimumRepetitions = quantifier?.minimumRepetitions ?? 1;
          const maximumRepetitions = quantifier === undefined
            ? 1
            : quantifier.maximumRepetitions;
          const greedy = quantifier?.greedy ?? false;
          const possessive =
            nullableUnboundedSimpleCaptureHistoryMaximum !== undefined
            && quantifier?.possessive === true
            && minimumRepetitions >= 2
            && maximumRepetitions !== minimumRepetitions;
          if (candidates.length > 1) append({ parts, value: "(?:" });
          for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            if (candidateIndex > 0) append({ parts, value: "|" });
            const candidate = candidates[candidateIndex]!;
            const targetCaptureIndex = candidate.physicalIndex;
            const {
              fixedTargetCodePointLength,
              candidateSource,
            } = (() => {
              switch (comparison) {
              case "exact":
                return {
                  fixedTargetCodePointLength: undefined,
                  candidateSource: undefined,
                };
              case "case-folded":
                return {
                  fixedTargetCodePointLength: fixedCodePointLength({
                    logicalIndex: candidate.logicalIndex,
                  }),
                  candidateSource: caseFoldedCandidateSource({
                    logicalIndex: candidate.logicalIndex,
                  }),
                };
              default: {
                const _ex: never = comparison;
                throw new Error(`Unhandled backreference comparison: ${_ex}`);
              }
              }
            })();
            const initialCaseFoldedCodePointLengthConstraint =
              fixedTargetCodePointLength !== undefined
              && maximumRepetitions !== null
              && minimumRepetitions === maximumRepetitions
                ? {
                  minimumCodePointLength:
                    fixedTargetCodePointLength * minimumRepetitions,
                  maximumCodePointLength:
                    fixedTargetCodePointLength * maximumRepetitions,
                }
                : undefined;
            const initialCaseFoldedCandidateSource =
              candidateSource === undefined
                ? undefined
                : repeatJqCaseFoldedCaptureCandidateSource({
                  source: candidateSource,
                  minimumRepetitions,
                  maximumRepetitions,
                  greedy,
                });
            captureSlots.push(undefined);
            const markerCaptureIndex = captureSlots.length;
            append({
              parts,
              value: `(?<$b${markerCaptureIndex}>`,
            });
            const sourceStart = emittedLength;
            const markerSource = (() => {
              switch (comparison) {
              case "exact":
                return `\\${targetCaptureIndex}`;
              case "case-folded":
                return greedy ? "[\\s\\S]*" : "[\\s\\S]*?";
              default: {
                const _ex: never = comparison;
                throw new Error(`Unhandled backreference comparison: ${_ex}`);
              }
              }
            })();
            append({ parts, value: markerSource });
            const sourceEnd = emittedLength;
            append({ parts, value: ")" });
            backreferenceAlternatives.push({
              id: backreferenceAlternatives.length,
              markerCaptureIndex,
              targetCaptureIndex,
              newerTargetCaptureIndexes: candidates
                .slice(0, candidateIndex)
                .filter((newer) =>
                  newer.logicalIndex === candidate.logicalIndex,
                )
                .map((newer) => newer.physicalIndex),
              comparison,
              minimumRepetitions,
              maximumRepetitions,
              greedy,
              possessive,
              initialCaseFoldedCodePointLengthConstraint,
              initialCaseFoldedCandidateSource,
              sourceStart,
              sourceEnd,
            });
          }
          if (candidates.length > 1) append({ parts, value: ")" });
          index = quantifier === undefined
            ? backreference.endIndex
            : quantifier.endIndex - 1;
          continue;
        }
        const escapeEnd = findJqEscapeEnd({ source, startIndex: index });
        append({
          parts,
          value: source.slice(index, Math.min(escapeEnd + 1, endIndex)),
        });
        index = Math.min(escapeEnd, endIndex - 1);
        continue;
      }
      if (character === "[") {
        const classEnd = findJqCharacterClassEnd({ source, startIndex: index });
        append({ parts, value: source.slice(index, classEnd + 1) });
        index = classEnd;
        continue;
      }
      const group = character === "(" ? groupByStart.get(index) : undefined;
      if (group === undefined) {
        append({ parts, value: character });
        continue;
      }
      append({
        parts,
        value: openCapture({
          logicalIndex: group.logicalIndex,
          originalPrefix: synthetic
            ? "("
            : source.slice(index, group.contentStartIndex),
          recursiveProjection: recursiveDepth > 0,
        }),
      });
      index = group.contentStartIndex - 1;
    }
    return parts.join("");
  };

  const expandedSource = emitSegment({
    startIndex: 0,
    endIndex: source.length,
    synthetic: false,
    activeCalls: new Set(),
    depth: 0,
    recursiveDepth: 0,
  });
  const subexpressionCallExpansionAdditionalAlternationCount = calls.length === 0
    ? 0
    : Math.max(
      0,
      countJqRegularExpressionAlternations({ source: expandedSource }) -
        countJqRegularExpressionAlternations({ source }),
    );

  return {
    source: expandedSource,
    captureNames,
    captureSlots,
    backreferenceAlternatives,
    positionAssertions,
    recursiveCaptureLogicalIndexes: [...recursiveCaptureLogicalIndexes],
    subexpressionCallExpansionAdditionalAlternationCount,
    hasNullableUnboundedSimpleCaptureHistory,
    hasTerminalOptionalCaptureHistoryProjectionReplay,
    hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
    plainUnboundedCaptureHistoryGroupCount,
    linearRuntimeUnboundedCaptureHistoryGroupCount,
  };
}

function collectJqPhysicalCaptureSourceRanges({
  source,
  physicalCaptureIndexes,
}: {
  source: string;
  physicalCaptureIndexes: ReadonlySet<number>;
}): readonly {
  readonly physicalCaptureIndex: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}[] {
  if (physicalCaptureIndexes.size === 0) return [];
  const requested = [...physicalCaptureIndexes].toSorted((left, right) => left - right);
  const groupEndIndexes = mapJqGroupEndIndexes({ source });
  const ranges: {
    readonly physicalCaptureIndex: number;
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[] = [];
  let captureIndex = 0;
  let requestedIndex = 0;

  for (let index = 0; index < source.length && requestedIndex < requested.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index = findJqEscapeEnd({ source, startIndex: index });
      continue;
    }
    if (character === "[") {
      index = findJqCharacterClassEnd({ source, startIndex: index });
      continue;
    }
    if (character !== "(") continue;

    let sourceStart: number | undefined;
    if (source[index + 1] !== "?") {
      sourceStart = index + 1;
    } else if (
      source[index + 2] === "<"
      && source[index + 3] !== "="
      && source[index + 3] !== "!"
    ) {
      const nameEnd = source.indexOf(">", index + 3);
      if (nameEnd < 0) throw new Error("expanded physical capture name is unterminated");
      sourceStart = nameEnd + 1;
    }
    if (sourceStart === undefined) continue;

    captureIndex += 1;
    const target = requested[requestedIndex]!;
    if (captureIndex < target) continue;
    if (captureIndex > target) {
      throw new Error("expanded physical capture index is missing");
    }
    const groupEndIndex = groupEndIndexes.get(index);
    if (groupEndIndex === undefined) {
      throw new Error("expanded physical capture end is missing");
    }
    ranges.push({
      physicalCaptureIndex: captureIndex,
      sourceStart,
      sourceEnd: groupEndIndex,
    });
    requestedIndex += 1;
  }

  if (requestedIndex !== requested.length) {
    throw new Error("expanded physical capture index is missing");
  }
  return ranges;
}

function rewriteDuplicateNamedCaptureGroups({
  source,
}: {
  source: string;
}): { readonly source: string; readonly captureNames: readonly (string | null)[] } {
  const captureNames = captureNamesFromSource({ source });
  const counts = new Map<string, number>();
  const duplicateNames = new Set<string>();
  let output = "";
  let inBracket = false;
  let internalSequence = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      output += character;
      if (index + 1 < source.length) output += source[++index]!;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      output += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      output += character;
      continue;
    }
    if (!inBracket && character === "(" && source[index + 1] === "?" && source[index + 2] === "<") {
      const marker = source[index + 3];
      if (marker !== "=" && marker !== "!") {
        const end = source.indexOf(">", index + 3);
        if (end !== -1) {
          const name = source.slice(index + 3, end);
          const count = counts.get(name) ?? 0;
          counts.set(name, count + 1);
          if (count > 0) {
            duplicateNames.add(name);
            internalSequence += 1;
            output += `(?<$d${internalSequence}>`;
          } else {
            output += source.slice(index, end + 1);
          }
          index = end;
          continue;
        }
      }
    }
    output += character;
  }

  for (const name of duplicateNames) {
    if (source.includes(`\\k<${name}>`) || source.includes(`\\g<${name}>`)) {
      throw new Error(`duplicate named capture backreference '${name}' is unsupported`);
    }
  }
  return { source: output, captureNames };
}

function consumeLeadingJqSearchStartAnchorAlternative({
  source,
  depth,
}: {
  source: string;
  depth: number;
}): { readonly source: string; readonly anchored: boolean } {
  if (source.startsWith(String.raw`\G`)) {
    return { source: source.slice(2), anchored: true };
  }
  if (depth >= 64 || source[0] !== "(") {
    return { source, anchored: false };
  }

  const groupEnd = mapJqGroupEndIndexes({ source }).get(0);
  if (groupEnd === undefined) return { source, anchored: false };

  let contentStart: number;
  if (source.startsWith("(?:") || source.startsWith("(?=")) {
    contentStart = 3;
  } else if (source.startsWith("(?<")) {
    const marker = source[3];
    if (marker === "=" || marker === "!") {
      return { source, anchored: false };
    }
    const nameEnd = source.indexOf(">", 3);
    if (nameEnd === -1 || nameEnd >= groupEnd) {
      return { source, anchored: false };
    }
    contentStart = nameEnd + 1;
  } else if (source[1] !== "?") {
    contentStart = 1;
  } else {
    return { source, anchored: false };
  }

  const inner = consumeLeadingJqSearchStartAnchor({
    source: source.slice(contentStart, groupEnd),
    depth: depth + 1,
  });
  if (!inner.anchored) return { source, anchored: false };
  return {
    source:
      source.slice(0, contentStart) +
      inner.source +
      source.slice(groupEnd),
    anchored: true,
  };
}

function consumeLeadingJqSearchStartAnchor({
  source,
  depth,
}: {
  source: string;
  depth: number;
}): { readonly source: string; readonly anchored: boolean } {
  const alternatives = splitTopLevelAlternatives({ source });
  if (alternatives.length === 0) return { source, anchored: false };
  const consumed = alternatives.map((alternative) =>
    consumeLeadingJqSearchStartAnchorAlternative({
      source: alternative,
      depth,
    }),
  );
  if (consumed.some((alternative) => !alternative.anchored)) {
    return { source, anchored: false };
  }
  return {
    source: consumed.map((alternative) => alternative.source).join("|"),
    anchored: true,
  };
}

function compileJqRegularExpressionInternal({
  pattern,
  flags,
  nullableUnboundedSimpleCaptureHistoryMaximum,
  plainUnboundedCaptureHistoryMaximum,
  linearRuntimeUnboundedCaptureHistoryMaximum,
  expandedSourceBudget,
}: {
  pattern: string;
  flags: string;
  nullableUnboundedSimpleCaptureHistoryMaximum?: number;
  plainUnboundedCaptureHistoryMaximum?: number;
  linearRuntimeUnboundedCaptureHistoryMaximum?: number;
  expandedSourceBudget?: number;
}): CompileJqRegularExpressionResult {
  const supportedFlags = new Set(["g", "i", "l", "m", "n", "p", "s", "x"]);
  for (const flag of flags) {
    if (!supportedFlags.has(flag)) {
      return {
        ok: false,
        message: `unsupported regular expression flag '${flag}'`,
      };
    }
  }

  const effectiveFlags = new Set(flags);
  const quotedPattern = translateJqQuotedLiterals({ source: pattern });
  const invalidCaptureName = invalidJqUserCaptureName({ source: quotedPattern });
  if (invalidCaptureName !== undefined) {
    return {
      ok: false,
      message: `Regex failure: invalid char in group name <${invalidCaptureName}>`,
    };
  }
  const wholeScoped = unwrapWholeInlineModifierGroup({ source: quotedPattern });
  const promotedWholeScoped =
    wholeScoped !== undefined &&
    !wholeScoped.enabled.has("x") &&
    !wholeScoped.disabled.has("x") &&
    !containsJqLocalModifier({ source: wholeScoped.source })
      ? wholeScoped
      : undefined;
  const hasLocalModifiers =
    promotedWholeScoped === undefined &&
    containsJqLocalModifier({ source: quotedPattern });
  const scoped = promotedWholeScoped;
  const inline = consumeLeadingInlineModifiers({
    source: scoped?.source ?? quotedPattern,
  });
  const ignoreCase =
    inline.modifiers.has("i") ||
    resolveScopedModifier({
      initial: effectiveFlags.has("i"),
      modifier: "i",
      scoped,
    });
  const multilineAnchors =
    inline.modifiers.has("m") ||
    resolveScopedModifier({
      initial: false,
      modifier: "m",
      scoped,
    });
  const inlineDotAll =
    inline.modifiers.has("s") ||
    resolveScopedModifier({
      initial: false,
      modifier: "s",
      scoped,
    });
  const extendedMode =
    inline.modifiers.has("x") ||
    resolveScopedModifier({
      initial: effectiveFlags.has("x"),
      modifier: "x",
      scoped,
    });
  // The seventh-code-point replay is proven only for the ordinary/global and
  // whole-pattern ignore-case modes exercised by the differential corpora.
  // Keep local modifiers and every other jq regular-expression mode on the
  // established six-code-point path until each interaction has its own proof.
  const uniformSevenCodePointCaptureHistoryReplayModeCompatible =
    !hasLocalModifiers &&
    [...effectiveFlags].every(
      flag => flag === "g" || flag === "i" || flag === "l",
    ) &&
    !multilineAnchors &&
    !inlineDotAll &&
    !extendedMode;
  const positiveVariableBackreferenceCaptureHistoryReplayCompatible =
    effectiveFlags.has("i") &&
    scoped === undefined &&
    inline.modifiers.size === 0 &&
    uniformSevenCodePointCaptureHistoryReplayModeCompatible;
  // Zero-minimum quantified references have a proven replay boundary only
  // for direct captures when jq's longest mode resolves the empty/non-empty
  // branch ordering. The proof covers case-sensitive l/gl as well as the
  // existing whole-pattern case-folded path. Prefix wrappers retain the
  // conservative native path.
  // Minimum-two quantified references are admitted separately because fixed
  // counts and references followed by a suffix require runtime state that the
  // bounded replay does not model. The structural proof below therefore keeps
  // only variable-width references at an alternative end.
  const minimumTwoVariableBackreferenceCaptureHistoryReplayCompatible =
    positiveVariableBackreferenceCaptureHistoryReplayCompatible;
  const zeroMinimumBackreferenceCaptureHistoryReplayCompatible =
    scoped === undefined &&
    inline.modifiers.size === 0 &&
    uniformSevenCodePointCaptureHistoryReplayModeCompatible &&
    effectiveFlags.has("l");

  const wholeMatchGuardedOptionalCaptureHistoryProjectionReplayCompatible =
    !ignoreCase
    && !hasLocalModifiers
    && scoped === undefined
    && inline.modifiers.size === 0
    && [...effectiveFlags].every(flag => flag === "g" || flag === "l")
    && !multilineAnchors
    && !inlineDotAll
    && !extendedMode;

  const terminalOptionalCaptureHistoryStopCompatible =
    !ignoreCase
    && !hasLocalModifiers
    && scoped === undefined
    && inline.modifiers.size === 0
    && [...effectiveFlags].every(flag => flag === "g")
    && !multilineAnchors
    && !inlineDotAll
    && !extendedMode;

  let source: string;
  try {
    source = hasLocalModifiers
      ? translateJqLocalModifierSegment({
        source: quotedPattern,
        initialState: {
          ignoreCase: effectiveFlags.has("i"),
          multilineAnchors: false,
          dotAll: effectiveFlags.has("m") || effectiveFlags.has("p"),
          extendedMode: effectiveFlags.has("x"),
        },
        insideGroup: false,
      })
      : extendedMode
        ? stripExtendedMode({ source: inline.source })
        : inline.source;
    source = translateResetMatchStart({ source });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression: ${message}` };
  }
  const searchStart = consumeLeadingJqSearchStartAnchor({
    source,
    depth: 0,
  });
  source = searchStart.source;
  const specialMode: JqSpecialRegularExpressionMode =
    source === String.raw`\X`
      ? "grapheme"
      : source === String.raw`\X+`
        ? "grapheme-one-or-more"
        : source === String.raw`\y`
          ? "grapheme-boundary"
          : source === String.raw`\Y`
            ? "non-grapheme-boundary"
            : "none";
  switch (specialMode) {
  case "none":
    break;
  case "grapheme":
  case "grapheme-one-or-more":
    source = String.raw`[\s\S]`;
    break;
  case "grapheme-boundary":
  case "non-grapheme-boundary":
    source = String.raw`(?=)`;
    break;
  default: {
    const _ex: never = specialMode;
    throw new Error(`Unhandled special regular expression mode: ${_ex}`);
  }
  }
  let relaxedSimpleCaptureHistoryGroupSignatures: ReadonlySet<string> =
    new Set<string>();
  let singletonRequiredSevenCodePointCaptureHistoryReplayCompatible = false;
  let preExpansionMatchesEmptyAtAnyPosition = false;
  try {
    const translatedClasses = translatePosixCharacterClasses({ source, characterClassMode: 'unicode' });
    source = translateJqBareLiteralAlphabeticEscapes({
      source: translatedClasses.source,
    });
    source = translateJqHexEscapes({ source });
    source = translateJqBracedCodePointEscapes({ source });
    source = translateJqWordOperators({ source });
    source = translateJqDigitOperators({ source });
    source = translateJqSpaceOperators({ source });
    source = translateJqSpecialCharacterOperators({ source });
    if (
      hasLocalModifiers ||
      !(effectiveFlags.has("m") || effectiveFlags.has("p") || inlineDotAll)
    ) {
      source = translateJqDotOperators({ source });
    }
    source = translateAbsoluteAnchors({ source });
    if (
      terminalOptionalCaptureHistoryStopCompatible
      && source.includes("|")
      && source.includes("?")
      && source.includes("*")
      && source.includes("\\")
    ) {
      source = rewriteJqTerminalOptionalCaptureHistoryBranches({ source });
    }
    const simpleCaptureHistoryGroupSignatures =
      collectSimpleCaptureHistoryGroupSignatures({
        source,
        allowPositiveVariableBackreferenceQuantifier:
          positiveVariableBackreferenceCaptureHistoryReplayCompatible,
        allowMinimumTwoVariableBackreferenceQuantifier:
          minimumTwoVariableBackreferenceCaptureHistoryReplayCompatible,
        allowZeroMinimumBackreferenceQuantifier:
          zeroMinimumBackreferenceCaptureHistoryReplayCompatible,
      });
    const singletonRequiredSevenCodePointCaptureHistoryGroupSignatures =
      collectSingletonRequiredSevenCodePointCaptureHistoryGroupSignatures({
        source,
      });
    singletonRequiredSevenCodePointCaptureHistoryReplayCompatible =
      !ignoreCase
      && !hasLocalModifiers
      && scoped === undefined
      && inline.modifiers.size === 0
      && [...effectiveFlags].every(flag => flag === "g" || flag === "l")
      && simpleCaptureHistoryGroupSignatures.size !== 0
      && simpleCaptureHistoryGroupSignatures.size ===
        singletonRequiredSevenCodePointCaptureHistoryGroupSignatures.size
      && [...simpleCaptureHistoryGroupSignatures].every((signature) =>
        singletonRequiredSevenCodePointCaptureHistoryGroupSignatures.has(
          signature,
        )
      );
    preExpansionMatchesEmptyAtAnyPosition =
      simpleCaptureHistoryGroupSignatures.size !== 0 &&
      !searchStart.anchored &&
      jqExpressionCanMatchEmptyAtAnyPosition({ source });
    // Preserve exactly the structurally proven relaxed replay shapes.
    // Ignore-case translation consumes the same signatures after case-fold
    // expansion, while case-sensitive longest zero-minimum references need
    // them unchanged to reach the bounded replay generator.
    relaxedSimpleCaptureHistoryGroupSignatures =
      simpleCaptureHistoryGroupSignatures;
    if (ignoreCase && !hasLocalModifiers) {
      source = translateJqUnicodeFullCaseFolds({ source });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression: ${message}` };
  }
  let captureNames: readonly (string | null)[];
  let captureSlots: readonly (number | undefined)[];
  let physicalCaptureSourceRanges: readonly {
    readonly physicalCaptureIndex: number;
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  let backreferenceAlternatives: readonly {
    readonly id: number;
    readonly markerCaptureIndex: number;
    readonly targetCaptureIndex: number;
    readonly newerTargetCaptureIndexes: readonly number[];
    readonly comparison: "exact" | "case-folded";
    readonly minimumRepetitions: number;
    readonly maximumRepetitions: number | null;
    readonly greedy: boolean;
    readonly possessive: boolean;
    readonly initialCaseFoldedCodePointLengthConstraint:
      | JqCaseFoldedBackreferenceLengthConstraint
      | undefined;
    readonly initialCaseFoldedCandidateSource: string | undefined;
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  let positionAssertions: readonly {
    readonly markerCaptureIndex: number;
    readonly kind: "boundary" | "non-boundary" | "search-start";
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[];
  let recursiveCaptureLogicalIndexes: readonly number[];
  let subexpressionCallExpansionAdditionalAlternationCount: number;
  let hasNullableUnboundedSimpleCaptureHistory: boolean;
  let hasTerminalOptionalCaptureHistoryProjectionReplay: boolean;
  let hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay: boolean;
  let plainUnboundedCaptureHistoryGroupCount: number;
  let linearRuntimeUnboundedCaptureHistoryGroupCount: number;
  try {
    const expanded = expandJqSubexpressionCalls({
      source,
      caseFoldAllBackreferences: ignoreCase && !hasLocalModifiers,
      longest: effectiveFlags.has("l"),
      nullableUnboundedSimpleCaptureHistoryMaximum,
      plainUnboundedCaptureHistoryMaximum,
      linearRuntimeUnboundedCaptureHistoryMaximum,
      relaxedSimpleCaptureHistoryGroupSignatures,
      allowWholeMatchGuardedOptionalCaptureHistoryProjectionReplay:
        wholeMatchGuardedOptionalCaptureHistoryProjectionReplayCompatible,
      maximumEmittedLength: expandedSourceBudget,
    });
    const rewritten = rewriteDuplicateNamedCaptureGroups({
      source: expanded.source,
    });
    if (
      expandedSourceBudget !== undefined
      && rewritten.source.length > expandedSourceBudget
    ) {
      throw new JqRegularExpressionSourceBudgetError();
    }
    source = rewritten.source;
    captureNames = expanded.captureNames;
    captureSlots = expanded.captureSlots;
    physicalCaptureSourceRanges = collectJqPhysicalCaptureSourceRanges({
      source,
      physicalCaptureIndexes: new Set(
        expanded.backreferenceAlternatives.flatMap(
          (alternative) => alternative.newerTargetCaptureIndexes,
        ),
      ),
    });
    backreferenceAlternatives = expanded.backreferenceAlternatives;
    positionAssertions = expanded.positionAssertions;
    recursiveCaptureLogicalIndexes = expanded.recursiveCaptureLogicalIndexes;
    subexpressionCallExpansionAdditionalAlternationCount =
      expanded.subexpressionCallExpansionAdditionalAlternationCount;
    hasNullableUnboundedSimpleCaptureHistory =
      expanded.hasNullableUnboundedSimpleCaptureHistory;
    hasTerminalOptionalCaptureHistoryProjectionReplay =
      expanded.hasTerminalOptionalCaptureHistoryProjectionReplay;
    hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay =
      expanded.hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay;
    plainUnboundedCaptureHistoryGroupCount =
      expanded.plainUnboundedCaptureHistoryGroupCount;
    linearRuntimeUnboundedCaptureHistoryGroupCount =
      expanded.linearRuntimeUnboundedCaptureHistoryGroupCount;
  } catch (error: unknown) {
    if (error instanceof JqRegularExpressionSourceBudgetError) {
      return {
        ok: false,
        message: "dynamic capture-history fallback exceeds the source budget",
      };
    }
    if (error instanceof JqNeverEndingRecursionError) {
      return { ok: false, message: "Regex failure: never ending recursion" };
    }
    if (error instanceof JqRegularExpressionFailureError) {
      return { ok: false, message: `Regex failure: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression: ${message}` };
  }

  const renderSource = ({
    disabledBackreferenceAlternatives,
    disabledPhysicalCaptures,
    caseFoldedBackreferenceLengthConstraints,
    preferLongestBackreferenceCandidates,
    searchStartCodePointIndex,
    disableEmptyAlternatives,
  }: {
    disabledBackreferenceAlternatives?: ReadonlySet<number>;
    disabledPhysicalCaptures?: ReadonlySet<number>;
    caseFoldedBackreferenceLengthConstraints?: ReadonlyMap<
      number,
      {
        readonly minimumCodePointLength: number;
        readonly maximumCodePointLength: number;
      }
    >;
    preferLongestBackreferenceCandidates?: boolean;
    searchStartCodePointIndex?: number;
    disableEmptyAlternatives?: boolean;
  }): string => {
    const replacements: {
      readonly sourceStart: number;
      readonly sourceEnd: number;
      readonly value: string;
    }[] = [];
    if (disableEmptyAlternatives === true) {
      for (const range of ignoreEmptyAlternativeRanges) {
        replacements.push({
          sourceStart: range.start,
          sourceEnd: range.end,
          value: "(?!)",
        });
      }
    }
    for (const capture of physicalCaptureSourceRanges) {
      if (disabledPhysicalCaptures?.has(capture.physicalCaptureIndex) !== true) {
        continue;
      }
      replacements.push({
        sourceStart: capture.sourceStart,
        sourceEnd: capture.sourceEnd,
        value: "(?!)",
      });
    }
    for (const alternative of backreferenceAlternatives) {
      if (disabledBackreferenceAlternatives?.has(alternative.id) === true) {
        replacements.push({
          sourceStart: alternative.sourceStart,
          sourceEnd: alternative.sourceEnd,
          value: "(?!)",
        });
        continue;
      }
      const constraint =
        caseFoldedBackreferenceLengthConstraints?.get(alternative.id)
        ?? alternative.initialCaseFoldedCodePointLengthConstraint;
      switch (alternative.comparison) {
      case "exact":
        break;
      case "case-folded":
        if (constraint !== undefined) {
          const { minimumCodePointLength, maximumCodePointLength } = constraint;
          replacements.push({
            sourceStart: alternative.sourceStart,
            sourceEnd: alternative.sourceEnd,
            value: minimumCodePointLength === maximumCodePointLength
              ? `[\\s\\S]{${minimumCodePointLength}}`
              : `[\\s\\S]{${minimumCodePointLength},${maximumCodePointLength}}?`,
          });
        } else if (alternative.initialCaseFoldedCandidateSource !== undefined) {
          replacements.push({
            sourceStart: alternative.sourceStart,
            sourceEnd: alternative.sourceEnd,
            value: alternative.initialCaseFoldedCandidateSource,
          });
        } else if (preferLongestBackreferenceCandidates === true) {
          replacements.push({
            sourceStart: alternative.sourceStart,
            sourceEnd: alternative.sourceEnd,
            value: "[\\s\\S]*",
          });
        }
        break;
      default: {
        const _ex: never = alternative.comparison;
        throw new Error(`Unhandled backreference comparison: ${_ex}`);
      }
      }
    }
    for (let index = 0; index < positionAssertions.length; index += 1) {
      const assertion = positionAssertions[index]!;
      const id = backreferenceAlternatives.length + index;
      if (disabledBackreferenceAlternatives?.has(id) === true) {
        replacements.push({
          sourceStart: assertion.sourceStart,
          sourceEnd: assertion.sourceEnd,
          value: "(?!)",
        });
        continue;
      }
      if (
        assertion.kind === "search-start" &&
        searchStartCodePointIndex !== undefined
      ) {
        replacements.push({
          sourceStart: assertion.sourceStart,
          sourceEnd: assertion.sourceEnd,
          value:
            `(?<=(?<![\\s\\S])[\\s\\S]{${searchStartCodePointIndex}})`,
        });
      }
    }
    if (replacements.length === 0) return source;

    const parts: string[] = [];
    let cursor = 0;
    for (const replacement of replacements.toSorted(
      (left, right) => left.sourceStart - right.sourceStart,
    )) {
      parts.push(source.slice(cursor, replacement.sourceStart), replacement.value);
      cursor = replacement.sourceEnd;
    }
    parts.push(source.slice(cursor));
    return parts.join("");
  };

  const baseFlags = hasLocalModifiers
    ? "du"
    : [
      "d",
      "u",
      ignoreCase ? "i" : "",
      multilineAnchors ? "m" : "",
      effectiveFlags.has("m") || effectiveFlags.has("p") || inlineDotAll
        ? "s"
        : "",
    ].join("");

  let emptyByteContinuation: "none" | "any" | "word" | "non-word";
  try {
    // Validate eagerly so invalid patterns become jq runtime errors.
    new RegExp(source, baseFlags);
    if (source === JQ_WORD_BOUNDARY) {
      emptyByteContinuation = "word";
    } else if (source === JQ_NON_WORD_BOUNDARY) {
      emptyByteContinuation = "non-word";
    } else {
      const interiorProbeInputs = ["xx", "aa", "00", "__", "  ", "!!", "x "];
      const matchesEmptyAtInterior = interiorProbeInputs.some((probeInput) => {
        const interiorProbe = new RegExp(source, `${baseFlags}y`);
        interiorProbe.lastIndex = 1;
        const interiorMatch = interiorProbe.exec(probeInput);
        return interiorMatch !== null &&
          interiorMatch.index === 1 &&
          interiorMatch[0] === "";
      });
      emptyByteContinuation =
        matchesEmptyAtInterior ||
        (
          nullableUnboundedSimpleCaptureHistoryMaximum !== undefined &&
          hasNullableUnboundedSimpleCaptureHistory &&
          preExpansionMatchesEmptyAtAnyPosition
        )
          ? "any"
          : "none";
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression: ${message}` };
  }

  const ignoreEmptyAlternativeSources = effectiveFlags.has("n")
    ? findIgnoreEmptyAlternativeSources({ source, captureNames })
    : [];
  const ignoreEmptyAlternativeRanges = effectiveFlags.has("n")
    ? findIgnoreEmptyAlternativeRanges({ source })
    : [];

  const compileBoundedSimpleCaptureHistoryFallback =
    nullableUnboundedSimpleCaptureHistoryMaximum === undefined
      && hasNullableUnboundedSimpleCaptureHistory
      ? (() => {
        let cache: Map<number, CompileJqRegularExpressionResult> | undefined;
        return ({
          maximumRepetitions,
        }: {
          readonly maximumRepetitions: number;
        }): CompileJqRegularExpressionResult => {
          const cacheable = Number.isSafeInteger(maximumRepetitions)
            && maximumRepetitions >= 0
            && maximumRepetitions <=
              JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_REPETITIONS;
          const cached = cacheable
            ? cache?.get(maximumRepetitions)
            : undefined;
          if (cached !== undefined) return cached;
          const compiledFallback = compileJqRegularExpressionInternal({
            pattern,
            flags,
            nullableUnboundedSimpleCaptureHistoryMaximum: maximumRepetitions,
            plainUnboundedCaptureHistoryMaximum,
          });
          if (cacheable) {
            cache ??= new Map<number, CompileJqRegularExpressionResult>();
            cache.set(maximumRepetitions, compiledFallback);
          }
          return compiledFallback;
        };
      })()
      : undefined;

  const compileBoundedPlainCaptureHistoryFallback =
    plainUnboundedCaptureHistoryMaximum === undefined
      && nullableUnboundedSimpleCaptureHistoryMaximum === undefined
      && !hasNullableUnboundedSimpleCaptureHistory
      && plainUnboundedCaptureHistoryGroupCount === 1
      && backreferenceAlternatives.length === 0
      && positionAssertions.length === 0
      && recursiveCaptureLogicalIndexes.length === 0
      ? (() => {
        let cachedMaximumRepetitions: number | undefined;
        let cachedResult: CompileJqRegularExpressionResult | undefined;
        return ({
          maximumRepetitions,
        }: {
          readonly maximumRepetitions: number;
        }): CompileJqRegularExpressionResult => {
          const cacheable = Number.isSafeInteger(maximumRepetitions)
            && maximumRepetitions >= 0
            && maximumRepetitions <=
              JQ_MAX_DYNAMIC_PLAIN_CAPTURE_HISTORY_INPUT_CODE_POINTS;
          if (
            cacheable &&
            cachedMaximumRepetitions === maximumRepetitions &&
            cachedResult !== undefined
          ) return cachedResult;
          const compiledFallback = compileJqRegularExpressionInternal({
            pattern,
            flags,
            nullableUnboundedSimpleCaptureHistoryMaximum,
            plainUnboundedCaptureHistoryMaximum: maximumRepetitions,
            expandedSourceBudget: JQ_MAX_DYNAMIC_CAPTURE_HISTORY_SOURCE_BUDGET,
          });
          if (cacheable) {
            cachedMaximumRepetitions = maximumRepetitions;
            cachedResult = compiledFallback;
          }
          return compiledFallback;
        };
      })()
      : undefined;


  const compileBoundedLinearRuntimeCaptureHistoryFallback =
    linearRuntimeUnboundedCaptureHistoryMaximum === undefined
      && plainUnboundedCaptureHistoryMaximum === undefined
      && nullableUnboundedSimpleCaptureHistoryMaximum === undefined
      && !hasNullableUnboundedSimpleCaptureHistory
      && plainUnboundedCaptureHistoryGroupCount === 0
      && linearRuntimeUnboundedCaptureHistoryGroupCount === 1
      && positionAssertions.length === 0
      && recursiveCaptureLogicalIndexes.length === 0
      ? (() => {
        let cachedMaximumRepetitions: number | undefined;
        let cachedResult: CompileJqRegularExpressionResult | undefined;
        return ({
          maximumRepetitions,
        }: {
          readonly maximumRepetitions: number;
        }): CompileJqRegularExpressionResult => {
          const cacheable = Number.isSafeInteger(maximumRepetitions)
            && maximumRepetitions >= 0
            && maximumRepetitions <=
              JQ_MAX_DYNAMIC_LINEAR_RUNTIME_CAPTURE_HISTORY_INPUT_CODE_POINTS;
          if (
            cacheable &&
            cachedMaximumRepetitions === maximumRepetitions &&
            cachedResult !== undefined
          ) return cachedResult;
          const sourceBudget =
            backreferenceAlternatives.length === 1
            && backreferenceAlternatives[0]?.comparison === "exact"
            && positionAssertions.length === 0
              ? JQ_MAX_DYNAMIC_LINEAR_RUNTIME_ELIDED_MARKER_SOURCE_BUDGET
              : JQ_MAX_DYNAMIC_CAPTURE_HISTORY_SOURCE_BUDGET;
          const compiledFallback = compileJqRegularExpressionInternal({
            pattern,
            flags,
            linearRuntimeUnboundedCaptureHistoryMaximum: maximumRepetitions,
            expandedSourceBudget: sourceBudget,
          });
          if (compiledFallback.ok) {
            jqGeneratedLinearRuntimeCaptureHistoryFallbacks.add(compiledFallback);
          }
          if (cacheable) {
            cachedMaximumRepetitions = maximumRepetitions;
            cachedResult = compiledFallback;
          }
          return compiledFallback;
        };
      })()
      : undefined;

  const uniformSevenCodePointCaptureHistoryReplayCompatible =
    uniformSevenCodePointCaptureHistoryReplayModeCompatible
    && !hasTerminalOptionalCaptureHistoryProjectionReplay
    && !hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay;

  return {
    ok: true,
    create: ({
      global,
      disabledBackreferenceAlternatives,
      disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints,
      preferLongestBackreferenceCandidates,
      searchStartCodePointIndex,
      disableEmptyAlternatives,
    }) =>
      new RegExp(
        renderSource({
          disabledBackreferenceAlternatives,
          disabledPhysicalCaptures,
          caseFoldedBackreferenceLengthConstraints,
          preferLongestBackreferenceCandidates,
          searchStartCodePointIndex,
          disableEmptyAlternatives,
        }),
        `${baseFlags}${searchStart.anchored ? "y" : global ? "g" : ""}`,
      ),
    createIgnoreEmptyAlternatives: () =>
      ignoreEmptyAlternativeSources.map((alternative) =>
        new RegExp(alternative, `${baseFlags}y`),
      ),
    hasIgnoreEmptyAlternatives: ignoreEmptyAlternativeRanges.length !== 0,
    requestedGlobal: effectiveFlags.has("g"),
    ignoreCase,
    uniformSevenCodePointCaptureHistoryReplayCompatible,
    singletonRequiredSevenCodePointCaptureHistoryReplayCompatible,
    wholeMatchGuardedOptionalCaptureHistoryProjectionReplay:
      hasWholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
    ignoreEmpty: effectiveFlags.has("n"),
    longest: effectiveFlags.has("l"),
    emptyByteContinuation,
    specialMode,
    captureNames,
    captureSlots,
    backreferenceAlternatives: backreferenceAlternatives.map((alternative) => ({
      id: alternative.id,
      markerCaptureIndex: alternative.markerCaptureIndex,
      targetCaptureIndex: alternative.targetCaptureIndex,
      newerTargetCaptureIndexes: alternative.newerTargetCaptureIndexes,
      comparison: alternative.comparison,
      minimumRepetitions: alternative.minimumRepetitions,
      maximumRepetitions: alternative.maximumRepetitions,
      greedy: alternative.greedy,
      possessive: alternative.possessive,
    })),
    positionAssertions: positionAssertions.map((assertion, index) => ({
      id: backreferenceAlternatives.length + index,
      markerCaptureIndex: assertion.markerCaptureIndex,
      kind: assertion.kind,
    })),
    recursiveCaptureLogicalIndexes,
    subexpressionCallExpansionAdditionalAlternationCount,
    prioritizeEarlyRuntimeAlternativeRejections:
      nullableUnboundedSimpleCaptureHistoryMaximum !== undefined,
    compileBoundedSimpleCaptureHistoryFallback,
    compileBoundedPlainCaptureHistoryFallback,
    compileBoundedLinearRuntimeCaptureHistoryFallback,
  };
}

export function compileJqRegularExpression({
  pattern,
  flags,
}: {
  pattern: string;
  flags: string;
}): CompileJqRegularExpressionResult {
  return compileJqRegularExpressionInternal({ pattern, flags });
}

interface RegExpExecArrayWithIndices extends RegExpExecArray {
  readonly indices: ([number, number] | undefined)[];
}

function withoutStatefulFlags({ flags }: { flags: string }): string {
  return flags.replace(/[gy]/gu, "");
}

function hasAlternationOrLazyQuantifier({ source }: { source: string }): boolean {
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      index += index + 1 < source.length ? 1 : 0;
      continue;
    }
    if (character === "[" && !inBracket) {
      inBracket = true;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      continue;
    }
    if (inBracket) continue;
    if (character === "|") return true;
    if (
      character === "?" &&
      index > 0 &&
      (source[index - 1] === "*" ||
        source[index - 1] === "+" ||
        source[index - 1] === "?" ||
        source[index - 1] === "}")
    ) {
      return true;
    }
  }
  return false;
}

function jqCandidateEndIndexes({
  input,
  startIndex,
}: {
  input: string;
  startIndex: number;
}): readonly number[] {
  const candidateEnds = [startIndex];
  for (let index = startIndex; index < input.length;) {
    const codePoint = input.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    candidateEnds.push(index);
  }
  return candidateEnds;
}

function findMatchAtStartEndingAt({
  input,
  regex,
  startIndex,
  endIndex,
}: {
  input: string;
  regex: RegExp;
  startIndex: number;
  endIndex: number;
}): RegExpExecArrayWithIndices | null {
  const remainingCodePointLength = Array.from(input.slice(endIndex)).length;
  const exact = new RegExp(
    String.raw`(?:${regex.source})(?=[\s\S]{${remainingCodePointLength}}(?![\s\S]))`,
    `${withoutStatefulFlags({ flags: regex.flags })}y`,
  );
  exact.lastIndex = startIndex;
  return exact.exec(input) as RegExpExecArrayWithIndices | null;
}

function findLongestMatchAtStart({
  input,
  regex,
  startIndex,
}: {
  input: string;
  regex: RegExp;
  startIndex: number;
}): RegExpExecArrayWithIndices | null {
  const candidateEnds = jqCandidateEndIndexes({ input, startIndex });
  for (
    let candidateIndex = candidateEnds.length - 1;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    const match = findMatchAtStartEndingAt({
      input,
      regex,
      startIndex,
      endIndex: candidateEnds[candidateIndex]!,
    });
    if (match !== null) return match;
  }
  return null;
}

function buildJqUtf8ByteOffsets({ input }: { input: string }): readonly (number | undefined)[] {
  const offsets: (number | undefined)[] = new Array(input.length + 1);
  offsets[0] = 0;
  let codeUnitOffset = 0;
  let byteOffset = 0;
  for (const character of input) {
    byteOffset += JQ_REGEXP_UTF8_ENCODER.encode(character).byteLength;
    codeUnitOffset += character.length;
    offsets[codeUnitOffset] = byteOffset;
  }
  return offsets;
}

function jqUtf8ByteLengthBetween({
  input,
  offsets,
  start,
  end,
}: {
  input: string;
  offsets: readonly (number | undefined)[];
  start: number;
  end: number;
}): number {
  const startOffset = offsets[start];
  const endOffset = offsets[end];
  return startOffset === undefined || endOffset === undefined
    ? JQ_REGEXP_UTF8_ENCODER.encode(input.slice(start, end)).byteLength
    : endOffset - startOffset;
}

function collectLongestMatchCandidates({
  input,
  regex,
  global,
  searchStartIndex,
}: {
  input: string;
  regex: RegExp;
  global: boolean;
  searchStartIndex: number;
}): readonly RegExpExecArrayWithIndices[] {
  const baseFlags = withoutStatefulFlags({ flags: regex.flags });
  const search = new RegExp(
    regex.source,
    `${baseFlags}${regex.sticky ? "y" : "g"}`,
  );
  const needsLocalLongestSearch = hasAlternationOrLazyQuantifier({
    source: regex.source,
  });
  const candidates: RegExpExecArrayWithIndices[] = [];
  let nextSearchIndex = searchStartIndex;

  while (nextSearchIndex <= input.length) {
    search.lastIndex = nextSearchIndex;
    const first = search.exec(input) as RegExpExecArrayWithIndices | null;
    if (first === null) break;
    const firstRange = first.indices[0];
    if (firstRange === undefined) break;
    const candidate = needsLocalLongestSearch
      ? findLongestMatchAtStart({ input, regex, startIndex: first.index })
      : first;
    if (candidate !== null) {
      candidates.push(candidate);
      const candidateRange = candidate.indices[0];
      if (candidateRange?.[1] === input.length && candidates.length === 1) {
        // The first candidate is necessarily the first globally selected
        // longest match when it reaches the input end, so no later start can
        // be observed.  A later end-reaching candidate is not sufficient to
        // stop: an earlier equal-length candidate wins jq's tie and may end
        // before it, leaving an overlapping empty match to emit afterward.
        if (global && candidateRange[0] !== candidateRange[1]) {
          const endProbe = new RegExp(regex.source, `${baseFlags}y`);
          endProbe.lastIndex = input.length;
          const endMatch = endProbe.exec(input) as RegExpExecArrayWithIndices | null;
          const endRange = endMatch?.indices[0];
          if (
            endMatch !== null &&
            endRange?.[0] === input.length &&
            endRange[1] === input.length
          ) {
            candidates.push(endMatch);
          }
        }
        break;
      }
    }

    // jq's `l` flag ranks candidates across every possible start offset,
    // including overlaps. Advancing to the previous match end can skip a
    // later-starting but longer candidate.
    nextSearchIndex = advanceAfterEmptyMatch({ input, index: first.index });
  }

  return candidates;
}

interface RankedLongestMatchCandidate {
  readonly raw: RegExpExecArrayWithIndices;
  readonly start: number;
  readonly end: number;
  readonly byteLength: number;
}

function firstCandidateAtOrAfter({
  candidates,
  startIndex,
}: {
  candidates: readonly RankedLongestMatchCandidate[];
  startIndex: number;
}): number {
  let lower = 0;
  let upper = candidates.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (candidates[middle]!.start < startIndex) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function rankLongestMatches({
  input,
  rawCandidates,
  global,
  ignoreEmpty,
}: {
  input: string;
  rawCandidates: readonly RegExpExecArrayWithIndices[];
  global: boolean;
  ignoreEmpty: boolean;
}): readonly RegExpExecArrayWithIndices[] {
  const utf8ByteOffsets = buildJqUtf8ByteOffsets({ input });
  const candidates = rawCandidates
    .toSorted((left, right) => {
      const leftRange = left.indices[0];
      const rightRange = right.indices[0];
      return (leftRange?.[0] ?? Number.MAX_SAFE_INTEGER) -
        (rightRange?.[0] ?? Number.MAX_SAFE_INTEGER);
    })
    .map((raw): RankedLongestMatchCandidate | undefined => {
      const range = raw.indices[0];
      if (range === undefined || (ignoreEmpty && range[0] === range[1])) {
        return undefined;
      }
      return {
        raw,
        start: range[0],
        end: range[1],
        // jq's Oniguruma-backed `l` mode compares UTF-8 byte lengths.
        byteLength: jqUtf8ByteLengthBetween({
          input,
          offsets: utf8ByteOffsets,
          start: range[0],
          end: range[1],
        }),
      };
    })
    .filter((candidate): candidate is RankedLongestMatchCandidate =>
      candidate !== undefined,
    );
  if (candidates.length === 0) return [];

  const suffixBest: number[] = new Array(candidates.length);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const nextBestIndex = suffixBest[index + 1];
    if (
      nextBestIndex === undefined ||
      candidates[index]!.byteLength >= candidates[nextBestIndex]!.byteLength
    ) {
      suffixBest[index] = index;
    } else {
      suffixBest[index] = nextBestIndex;
    }
  }

  const selected: RegExpExecArrayWithIndices[] = [];
  let candidateIndex = 0;
  while (candidateIndex < candidates.length) {
    const bestIndex = suffixBest[candidateIndex]!;
    const best = candidates[bestIndex]!;
    selected.push(best.raw);
    if (!global) break;
    const nextStart = best.end > best.start
      ? best.end
      : advanceAfterEmptyMatch({ input, index: best.end });
    candidateIndex = firstCandidateAtOrAfter({ candidates, startIndex: nextStart });
  }
  return selected;
}

function selectLongestMatches({
  input,
  regex,
  global,
  ignoreEmpty,
}: {
  input: string,
  regex: RegExp,
  global: boolean,
  ignoreEmpty: boolean,
}): readonly RegExpExecArrayWithIndices[] {
  return rankLongestMatches({
    input,
    rawCandidates: collectLongestMatchCandidates({
      input,
      regex,
      global,
      searchStartIndex: 0,
    }),
    global,
    ignoreEmpty,
  });
}

function isInteriorSurrogateBoundary({
  input,
  index,
}: {
  input: string;
  index: number;
}): boolean {
  if (index <= 0 || index >= input.length) return false;
  const previous = input.charCodeAt(index - 1);
  const current = input.charCodeAt(index);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function codePointLengthAt({
  input,
  index,
}: {
  input: string;
  index: number;
}): number {
  const codePoint = input.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function advanceAfterEmptyMatch({
  input,
  index,
}: {
  input: string;
  index: number;
}): number {
  if (index >= input.length) return input.length + 1;
  return index + codePointLengthAt({ input, index });
}

function utf8ByteLengthAt({
  input,
  index,
}: {
  input: string;
  index: number;
}): number {
  if (index >= input.length) return 0;
  return JQ_REGEXP_UTF8_ENCODER.encode(
    input.slice(index, index + codePointLengthAt({ input, index })),
  ).byteLength;
}

function isJqWordCharacterAt({
  input,
  index,
}: {
  input: string;
  index: number;
}): boolean {
  if (index >= input.length) return false;
  const character = String.fromCodePoint(input.codePointAt(index)!);
  return JQ_WORD_CHARACTER_REGEXP.test(character);
}

function shouldDuplicateEmptyMatchAcrossUtf8Bytes({
  input,
  index,
  mode,
}: {
  input: string;
  index: number;
  mode: "none" | "any" | "word" | "non-word";
}): boolean {
  if (index >= input.length) return false;
  switch (mode) {
  case "none":
    return false;
  case "any":
    return true;
  case "word":
    return isJqWordCharacterAt({ input, index });
  case "non-word":
    return !isJqWordCharacterAt({ input, index });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled empty-match continuation mode: ${_ex}`);
  }
  }
}

function findFirstNonEmptyAlternativeMatchAtStart({
  input,
  startIndex,
  alternatives,
}: {
  input: string;
  startIndex: number;
  alternatives: readonly RegExp[];
}): RegExpExecArrayWithIndices | null {
  for (const alternative of alternatives) {
    alternative.lastIndex = startIndex;
    const candidate = alternative.exec(input) as RegExpExecArrayWithIndices | null;
    const range = candidate?.indices[0];
    if (
      candidate !== null &&
      range !== undefined &&
      range[0] === startIndex &&
      range[1] > range[0]
    ) {
      return candidate;
    }
  }
  return null;
}

function isJqHangulCharacter({ character }: { character: string }): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}

function splitJqLegacyGraphemeSegment({
  segment,
  start,
}: {
  segment: string;
  start: number;
}): readonly { readonly start: number; readonly end: number }[] {
  const codePoints = Array.from(segment);
  const letterCount = codePoints.filter((character) =>
    JQ_UNICODE_LETTER_REGEXP.test(character),
  ).length;
  if (
    letterCount <= 1 ||
    codePoints.every(
      (character) =>
        !JQ_UNICODE_LETTER_REGEXP.test(character) ||
        isJqHangulCharacter({ character }),
    )
  ) {
    return [{ start, end: start + segment.length }];
  }

  const ranges: { start: number; end: number }[] = [];
  let partStart = start;
  let cursor = start;
  let sawLetter = false;
  for (const character of codePoints) {
    const isLetter = JQ_UNICODE_LETTER_REGEXP.test(character);
    if (sawLetter && isLetter && !isJqHangulCharacter({ character })) {
      ranges.push({ start: partStart, end: cursor });
      partStart = cursor;
      sawLetter = false;
    }
    cursor += character.length;
    sawLetter ||= isLetter;
  }
  ranges.push({ start: partStart, end: cursor });
  return ranges;
}

function collectFirstJqGraphemeRange({
  input,
}: {
  input: string;
}): { readonly start: number; readonly end: number } | undefined {
  const first = JQ_GRAPHEME_SEGMENTER.segment(input)[Symbol.iterator]().next();
  if (first.done) return undefined;
  return splitJqLegacyGraphemeSegment({
    segment: first.value.segment,
    start: first.value.index,
  })[0];
}

function findFirstJqNonGraphemeBoundary({
  input,
}: {
  input: string;
}): number | undefined {
  for (const { segment, index } of JQ_GRAPHEME_SEGMENTER.segment(input)) {
    for (const range of splitJqLegacyGraphemeSegment({
      segment,
      start: index,
    })) {
      const boundary = range.start + codePointLengthAt({
        input,
        index: range.start,
      });
      if (boundary < range.end) return boundary;
    }
  }
  return undefined;
}

function collectJqGraphemeRanges({
  input,
}: {
  input: string;
}): readonly { readonly start: number; readonly end: number }[] {
  return Array.from(JQ_GRAPHEME_SEGMENTER.segment(input)).flatMap(
    ({ segment, index }) =>
      splitJqLegacyGraphemeSegment({ segment, start: index }),
  );
}

function collectJqSpecialRegularExpressionMatches({
  input,
  mode,
  global,
  longest,
  ignoreEmpty,
}: {
  input: string;
  mode: Exclude<JqSpecialRegularExpressionMode, "none">;
  global: boolean;
  longest: boolean;
  ignoreEmpty: boolean;
}): readonly JqRegularExpressionMatch[] {
  switch (mode) {
  case "grapheme-one-or-more":
    return input.length === 0
      ? []
      : [{ start: 0, end: input.length, text: input, captures: [] }];
  case "grapheme-boundary": {
    if (ignoreEmpty) return [];
    if (!global) {
      return [{ start: 0, end: 0, text: "", captures: [] }];
    }
    const matches: JqRegularExpressionMatch[] = [{
      start: 0, end: 0, text: "", captures: [],
    }];
    for (const range of collectJqGraphemeRanges({ input })) {
      const firstCodePointLength = codePointLengthAt({
        input,
        index: range.start,
      });
      const continuationCount =
        utf8ByteLengthAt({ input, index: range.start }) - 1;
      const continuationIndex = range.start + firstCodePointLength;
      for (let count = 0; count < continuationCount; count += 1) {
        matches.push({
          start: continuationIndex,
          end: continuationIndex,
          text: "",
          captures: [],
        });
      }
      matches.push({
        start: range.end,
        end: range.end,
        text: "",
        captures: [],
      });
    }
    return global ? matches : matches.slice(0, 1);
  }
  case "non-grapheme-boundary": {
    if (input.length === 0 || ignoreEmpty) return [];
    if (!global) {
      const boundary = findFirstJqNonGraphemeBoundary({ input });
      return boundary === undefined
        ? []
        : [{
          start: boundary,
          end: boundary,
          text: "",
          captures: [],
        }];
    }
    const graphemeBoundaries = new Set<number>([0]);
    for (const range of collectJqGraphemeRanges({ input })) {
      graphemeBoundaries.add(range.end);
    }
    const ranges: { start: number; end: number }[] = [];
    let index = 0;
    for (const character of input) {
      index += character.length;
      if (index < input.length && !graphemeBoundaries.has(index)) {
        ranges.push({ start: index, end: index });
        if (!global) break;
      }
    }
    return ranges.map(({ start, end }) => ({
      start,
      end,
      text: "",
      captures: [],
    }));
  }
  case "grapheme": {
    if (input.length === 0) return [];
    if (!global && !longest) {
      const first = collectFirstJqGraphemeRange({ input });
      return first === undefined
        ? []
        : [{
          start: first.start,
          end: first.end,
          text: input.slice(first.start, first.end),
          captures: [],
        }];
    }
    const ranges = collectJqGraphemeRanges({ input });
    let selected = global ? ranges : ranges.slice(0, 1);
    if (longest && ranges.length !== 0) {
      const byteLengths = ranges.map(({ start, end }) =>
        JQ_REGEXP_UTF8_ENCODER.encode(input.slice(start, end)).byteLength,
      );
      const suffixBest: number[] = new Array(ranges.length);
      for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const nextBest = suffixBest[index + 1];
        suffixBest[index] =
          nextBest === undefined || byteLengths[index]! >= byteLengths[nextBest]!
            ? index
            : nextBest;
      }
      const longestRanges: { start: number; end: number }[] = [];
      let candidateIndex = 0;
      while (candidateIndex < ranges.length) {
        const bestIndex = suffixBest[candidateIndex]!;
        longestRanges.push(ranges[bestIndex]!);
        if (!global) break;
        candidateIndex = bestIndex + 1;
      }
      selected = longestRanges;
    }
    return selected.map(({ start, end }) => ({
      start,
      end,
      text: input.slice(start, end),
      captures: [],
    }));
  }
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled special regular expression mode: ${_ex}`);
  }
  }
}

function jqGraphemeBoundaryIndexes({
  input,
}: {
  input: string;
}): ReadonlySet<number> {
  const boundaries = new Set<number>([0]);
  for (const range of collectJqGraphemeRanges({ input })) {
    boundaries.add(range.end);
  }
  return boundaries;
}

interface JqRegularExpressionRuntimeValidationContext {
  readonly graphemeBoundaries: ReadonlySet<number> | undefined;
  readonly inputLength: number;
  readonly searchStartCodePointIndexes:
    readonly (number | undefined)[] | undefined;
}

function buildJqCodePointIndexesByCodeUnit({
  input,
}: {
  input: string;
}): readonly (number | undefined)[] {
  const indexes: (number | undefined)[] = new Array(input.length + 1);
  indexes[0] = 0;
  let codeUnitIndex = 0;
  let codePointIndex = 0;
  for (const character of input) {
    codeUnitIndex += character.length;
    codePointIndex += 1;
    indexes[codeUnitIndex] = codePointIndex;
  }
  return indexes;
}

function createJqRegularExpressionRuntimeValidationContext({
  input,
  compiled,
}: {
  input: string;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
}): JqRegularExpressionRuntimeValidationContext {
  const hasSearchStartAssertion = compiled.positionAssertions.some(
    (assertion) => assertion.kind === "search-start",
  );
  return {
    inputLength: input.length,
    graphemeBoundaries: compiled.positionAssertions.some(
      (assertion) => assertion.kind !== "search-start",
    )
      ? jqGraphemeBoundaryIndexes({ input })
      : undefined,
    searchStartCodePointIndexes: hasSearchStartAssertion
      ? buildJqCodePointIndexesByCodeUnit({ input })
      : undefined,
  };
}

function jqSearchStartCodePointIndex({
  context,
  codeUnitIndex,
}: {
  context: JqRegularExpressionRuntimeValidationContext;
  codeUnitIndex: number;
}): number {
  const codePointIndex = context.searchStartCodePointIndexes?.[codeUnitIndex];
  if (codePointIndex === undefined) {
    throw new Error("search-start code-point index is missing");
  }
  return codePointIndex;
}

function jqCaseInsensitiveBackreferenceMatches({
  target,
  candidate,
  hasInputSuffix,
}: {
  target: string;
  candidate: string;
  hasInputSuffix: boolean;
}): boolean {
  const targetCharacters = [...target];
  const candidateCharacters = [...candidate];
  if (targetCharacters.length !== candidateCharacters.length) return false;
  return targetCharacters.every((targetCharacter, index) =>
    jqCaseInsensitiveBackreferenceCharactersEqual({
      left: targetCharacter,
      right: candidateCharacters[index]!,
      hasInputSuffix,
    }),
  );
}

interface JqCaseFoldedBackreferenceLengthConstraint {
  readonly minimumCodePointLength: number;
  readonly maximumCodePointLength: number;
}

interface JqRuntimeAlternativeState {
  readonly disabled: ReadonlySet<number>;
  readonly disabledPhysicalCaptures: ReadonlySet<number>;
  readonly caseFoldedBackreferenceLengthConstraints: ReadonlyMap<
    number,
    JqCaseFoldedBackreferenceLengthConstraint
  >;
}

type JqRuntimeAlternativeRejection =
  | {
      readonly id: number;
      readonly kind: "disable";
      readonly retryShorterEnd: boolean;
    }
  | {
      readonly physicalCaptureIndex: number;
      readonly kind: "disable-capture";
    }
  | {
      readonly id: number;
      readonly kind: "case-fold-length" | "case-fold-retry-length";
      readonly constraint: JqCaseFoldedBackreferenceLengthConstraint;
    };

function runtimeAlternativeRejections({
  input,
  raw,
  compiled,
  context,
  searchStartIndex,
}: {
  input: string;
  raw: RegExpExecArrayWithIndices;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
  context: JqRegularExpressionRuntimeValidationContext;
  searchStartIndex: number | undefined;
}): readonly JqRuntimeAlternativeRejection[] {
  const rejected: JqRuntimeAlternativeRejection[] = [];
  for (const alternative of compiled.backreferenceAlternatives) {
    const marker = raw.indices[alternative.markerCaptureIndex];
    if (marker === undefined) continue;
    const target = raw.indices[alternative.targetCaptureIndex];
    const participatingNewerCaptureIndex =
      alternative.newerTargetCaptureIndexes.find(
        (captureIndex) => raw.indices[captureIndex] !== undefined,
      );
    if (participatingNewerCaptureIndex !== undefined) {
      if (
        compiled.prioritizeEarlyRuntimeAlternativeRejections &&
        !compiled.longest
      ) {
        // jq's bounded non-longest history fallback can backtrack a newer
        // nullable repetition out of participation and then resolve this
        // reference from an older physical capture. Disabling the older marker
        // instead would permanently skip that history branch. Replace only the
        // newer capture body; its surrounding optional shape remains responsible
        // for deciding whether the branch can be absent.
        rejected.push({
          physicalCaptureIndex: participatingNewerCaptureIndex,
          kind: "disable-capture",
        });
      } else {
        rejected.push({
          id: alternative.id,
          kind: "disable",
          retryShorterEnd: false,
        });
      }
      continue;
    }
    if (target === undefined) {
      rejected.push({
        id: alternative.id,
        kind: "disable",
        retryShorterEnd: false,
      });
      continue;
    }
    const targetText = input.slice(target[0], target[1]);
    const candidateText = input.slice(marker[0], marker[1]);
    switch (alternative.comparison) {
    case "exact":
      if (targetText !== candidateText) {
        rejected.push({
          id: alternative.id,
          kind: "disable",
          retryShorterEnd: false,
        });
      }
      continue;
    case "case-folded":
      break;
    default: {
      const _ex: never = alternative.comparison;
      throw new Error(`Unhandled backreference comparison: ${_ex}`);
    }
    }

    const targetCharacters = [...targetText];
    const candidateCharacters = [...candidateText];
    const targetCodePointLength = targetCharacters.length;
    if (targetCodePointLength === 0) {
      if (candidateCharacters.length !== 0) {
        rejected.push({
          id: alternative.id,
          kind: "case-fold-length",
          constraint: {
            minimumCodePointLength: 0,
            maximumCodePointLength: 0,
          },
        });
      }
      continue;
    }

    const maximumRepetitions = alternative.maximumRepetitions ??
      Number.POSITIVE_INFINITY;
    const maximumCandidateRepetitions = Math.min(
      Math.floor(candidateCharacters.length / targetCodePointLength),
      maximumRepetitions,
    );
    const validLengths: number[] = [];
    let allChunksMatch = true;
    for (
      let repetition = 1;
      repetition <= maximumCandidateRepetitions;
      repetition += 1
    ) {
      const chunk = candidateCharacters
        .slice(
          (repetition - 1) * targetCodePointLength,
          repetition * targetCodePointLength,
        )
        .join("");
      const chunkEnd = marker[0] + candidateCharacters
        .slice(0, repetition * targetCodePointLength)
        .join("").length;
      if (!jqCaseInsensitiveBackreferenceMatches({
        target: targetText,
        candidate: chunk,
        hasInputSuffix: chunkEnd < input.length,
      })) {
        allChunksMatch = false;
        break;
      }
      if (repetition >= alternative.minimumRepetitions) {
        validLengths.push(repetition * targetCodePointLength);
      }
    }
    if (alternative.minimumRepetitions === 0) validLengths.unshift(0);
    if (alternative.possessive) {
      const availableCharacters = [...input.slice(marker[0])];
      const maximumAvailableRepetitions = Math.min(
        Math.floor(availableCharacters.length / targetCodePointLength),
        maximumRepetitions,
      );
      let possessiveRepetitions = 0;
      for (
        let repetition = 1;
        repetition <= maximumAvailableRepetitions;
        repetition += 1
      ) {
        const chunk = availableCharacters
          .slice(
            (repetition - 1) * targetCodePointLength,
            repetition * targetCodePointLength,
          )
          .join("");
        const chunkEnd = marker[0] + availableCharacters
          .slice(0, repetition * targetCodePointLength)
          .join("").length;
        if (!jqCaseInsensitiveBackreferenceMatches({
          target: targetText,
          candidate: chunk,
          hasInputSuffix: chunkEnd < input.length,
        })) break;
        possessiveRepetitions = repetition;
      }
      if (possessiveRepetitions >= alternative.minimumRepetitions) {
        const possessiveLength =
          possessiveRepetitions * targetCodePointLength;
        if (candidateCharacters.length !== possessiveLength) {
          rejected.push({
            id: alternative.id,
            kind: "case-fold-length",
            constraint: {
              minimumCodePointLength: possessiveLength,
              maximumCodePointLength: possessiveLength,
            },
          });
          continue;
        }
      }
    }
    const candidateRepetitions = candidateCharacters.length /
      targetCodePointLength;
    const candidateIsValid =
      Number.isInteger(candidateRepetitions) &&
      candidateRepetitions >= alternative.minimumRepetitions &&
      candidateRepetitions <= maximumRepetitions &&
      allChunksMatch &&
      validLengths.includes(candidateCharacters.length);
    if (candidateIsValid) continue;

    const preferredLength = alternative.greedy
      ? validLengths.at(-1)
      : validLengths[0];
    if (preferredLength === undefined) {
      // A broad structural marker can let the referenced capture greedily
      // consume text that belongs to the backreference. Replace, rather than
      // intersect, its exact length one code point at a time so the native
      // engine can reconsider that internal split. The global runtime-state
      // cap bounds this search independently of the input length.
      const nextCandidateLength = candidateCharacters.length + 1;
      if (nextCandidateLength <= context.inputLength) {
        rejected.push({
          id: alternative.id,
          kind: "case-fold-retry-length",
          constraint: {
            minimumCodePointLength: nextCandidateLength,
            maximumCodePointLength: nextCandidateLength,
          },
        });
      } else {
        rejected.push({
          id: alternative.id,
          kind: "disable",
          retryShorterEnd: true,
        });
      }
      continue;
    }
    rejected.push({
      id: alternative.id,
      kind: "case-fold-length",
      constraint: {
        minimumCodePointLength: preferredLength,
        maximumCodePointLength: preferredLength,
      },
    });
  }
  for (const assertion of compiled.positionAssertions) {
    const marker = raw.indices[assertion.markerCaptureIndex];
    if (marker === undefined) continue;
    const valid = (() => {
      switch (assertion.kind) {
      case "boundary": {
        const boundaries = context.graphemeBoundaries;
        if (boundaries === undefined) {
          throw new Error("position-assertion grapheme boundaries are missing");
        }
        return boundaries.has(marker[0]);
      }
      case "non-boundary": {
        const boundaries = context.graphemeBoundaries;
        if (boundaries === undefined) {
          throw new Error("position-assertion grapheme boundaries are missing");
        }
        return marker[0] > 0 &&
          marker[0] < context.inputLength &&
          !boundaries.has(marker[0]);
      }
      case "search-start":
        if (searchStartIndex === undefined) {
          throw new Error("search-start assertion position is missing");
        }
        return marker[0] === searchStartIndex;
      default: {
        const _ex: never = assertion.kind;
        throw new Error(`Unhandled position assertion: ${_ex}`);
      }
      }
    })();
    if (!valid) {
      rejected.push({
        id: assertion.id,
        kind: "disable",
        retryShorterEnd: true,
      });
    }
  }
  return rejected;
}

function runtimeAlternativeRejectionMayNeedShorterEnd({
  rejection,
}: {
  rejection: JqRuntimeAlternativeRejection;
}): boolean {
  switch (rejection.kind) {
  case "case-fold-length":
  case "case-fold-retry-length":
    return true;
  case "disable":
    return rejection.retryShorterEnd;
  case "disable-capture":
    return false;
  default: {
    const _ex: never = rejection;
    throw new Error(
      `Unhandled runtime alternative rejection: ${
        ((_ex satisfies never) as { readonly kind: string }).kind
      }`,
    );
  }
  }
}

function runtimeAlternativeStateKey({
  state,
}: {
  state: JqRuntimeAlternativeState;
}): string {
  const disabled = [...state.disabled]
    .sort((left, right) => left - right)
    .join(",");
  const disabledCaptures = [...state.disabledPhysicalCaptures]
    .sort((left, right) => left - right)
    .join(",");
  const constraints = [...state.caseFoldedBackreferenceLengthConstraints]
    .toSorted(([left], [right]) => left - right)
    .map(([id, constraint]) =>
      `${id}:${constraint.minimumCodePointLength}:${constraint.maximumCodePointLength}`,
    )
    .join(",");
  return `d=${disabled};c=${disabledCaptures};l=${constraints}`;
}

function applyRuntimeAlternativeRejection({
  state,
  rejection,
}: {
  state: JqRuntimeAlternativeState;
  rejection: JqRuntimeAlternativeRejection;
}): JqRuntimeAlternativeState | undefined {
  switch (rejection.kind) {
  case "disable": {
    if (state.disabled.has(rejection.id)) return undefined;
    const disabled = new Set(state.disabled);
    disabled.add(rejection.id);
    const constraints = new Map(
      state.caseFoldedBackreferenceLengthConstraints,
    );
    constraints.delete(rejection.id);
    return {
      disabled,
      disabledPhysicalCaptures: state.disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints: constraints,
    };
  }
  case "disable-capture": {
    if (state.disabledPhysicalCaptures.has(rejection.physicalCaptureIndex)) {
      return undefined;
    }
    const disabledPhysicalCaptures = new Set(state.disabledPhysicalCaptures);
    disabledPhysicalCaptures.add(rejection.physicalCaptureIndex);
    return {
      disabled: state.disabled,
      disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints:
        state.caseFoldedBackreferenceLengthConstraints,
    };
  }
  case "case-fold-length":
  case "case-fold-retry-length": {
    if (state.disabled.has(rejection.id)) return undefined;
    const previous = state.caseFoldedBackreferenceLengthConstraints.get(
      rejection.id,
    );
    const replacesPrevious = rejection.kind === "case-fold-retry-length";
    const minimumCodePointLength = replacesPrevious
      ? rejection.constraint.minimumCodePointLength
      : Math.max(
        previous?.minimumCodePointLength ?? 0,
        rejection.constraint.minimumCodePointLength,
      );
    const maximumCodePointLength = replacesPrevious
      ? rejection.constraint.maximumCodePointLength
      : Math.min(
        previous?.maximumCodePointLength ?? Number.POSITIVE_INFINITY,
        rejection.constraint.maximumCodePointLength,
      );
    if (minimumCodePointLength > maximumCodePointLength) {
      return applyRuntimeAlternativeRejection({
        state,
        rejection: {
          id: rejection.id,
          kind: "disable",
          retryShorterEnd: false,
        },
      });
    }
    if (
      previous?.minimumCodePointLength === minimumCodePointLength &&
      previous.maximumCodePointLength === maximumCodePointLength
    ) {
      return undefined;
    }
    const constraints = new Map(
      state.caseFoldedBackreferenceLengthConstraints,
    );
    constraints.set(rejection.id, {
      minimumCodePointLength,
      maximumCodePointLength,
    });
    return {
      disabled: state.disabled,
      disabledPhysicalCaptures: state.disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints: constraints,
    };
  }
  default: {
    const _ex: never = rejection;
    throw new Error(
      `Unhandled runtime alternative rejection: ${
        ((_ex satisfies never) as { readonly kind: string }).kind
      }`,
    );
  }
  }
}

function initialRuntimeAlternativeState(): JqRuntimeAlternativeState {
  return {
    disabled: new Set(),
    disabledPhysicalCaptures: new Set(),
    caseFoldedBackreferenceLengthConstraints: new Map(),
  };
}

function findFirstValidBackreferenceMatch({
  input,
  compiled,
  searchIndex,
  context,
  disableEmptyAlternatives,
  requiredStartIndex,
  requireNonEmpty,
  preferNonEmptyAtSearchStart,
}: {
  input: string;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
  searchIndex: number;
  context: JqRegularExpressionRuntimeValidationContext;
  disableEmptyAlternatives: boolean;
  requiredStartIndex: number | undefined;
  requireNonEmpty: boolean;
  preferNonEmptyAtSearchStart: boolean;
}): RegExpExecArrayWithIndices | null {
  const regexByState = new Map<string, RegExp>();
  const getRegex = ({
    state,
    sticky,
    searchStartCodePointIndex,
  }: {
    state: JqRuntimeAlternativeState;
    sticky: boolean;
    searchStartCodePointIndex: number | undefined;
  }): RegExp => {
    const stateKey = runtimeAlternativeStateKey({ state });
    const key = `${sticky ? "y" : "g"}:${searchStartCodePointIndex ?? "-"}:${stateKey}`;
    const existing = regexByState.get(key);
    if (existing !== undefined) return existing;
    const base = compiled.create({
      global: true,
      disabledBackreferenceAlternatives: state.disabled,
      disabledPhysicalCaptures: state.disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints:
        state.caseFoldedBackreferenceLengthConstraints,
      searchStartCodePointIndex,
      disableEmptyAlternatives,
    });
    const created = sticky
      ? new RegExp(base.source, `${withoutStatefulFlags({ flags: base.flags })}y`)
      : base;
    regexByState.set(key, created);
    return created;
  };
  let fallbackEvaluationCount = 0;
  const findValidAtShorterEnd = ({
    startIndex,
    beforeEndIndex,
    searchStartCodePointIndex,
  }: {
    startIndex: number;
    beforeEndIndex: number;
    searchStartCodePointIndex: number | undefined;
  }): RegExpExecArrayWithIndices | null => {
    const candidateEnds = jqCandidateEndIndexes({ input, startIndex });
    for (
      let candidateIndex = candidateEnds.length - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const endIndex = candidateEnds[candidateIndex]!;
      if (endIndex >= beforeEndIndex) continue;
      if (requireNonEmpty && endIndex === startIndex) continue;
      const queue: JqRuntimeAlternativeState[] = [
        initialRuntimeAlternativeState(),
      ];
      const queued = new Set([
        runtimeAlternativeStateKey({ state: queue[0]! }),
      ]);
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
        if (
          queueIndex >= JQ_MAX_RUNTIME_ALTERNATIVE_STATES ||
          fallbackEvaluationCount >= JQ_MAX_RUNTIME_FALLBACK_EVALUATIONS
        ) {
          throw new JqRegularExpressionRuntimeError(
            "regular expression runtime fallback exceeds the safe limit",
          );
        }
        fallbackEvaluationCount += 1;
        const state = queue[queueIndex]!;
        const base = compiled.create({
          global: false,
          disabledBackreferenceAlternatives: state.disabled,
          disabledPhysicalCaptures: state.disabledPhysicalCaptures,
          caseFoldedBackreferenceLengthConstraints:
            state.caseFoldedBackreferenceLengthConstraints,
          searchStartCodePointIndex,
          disableEmptyAlternatives,
        });
        const raw = findMatchAtStartEndingAt({
          input,
          regex: base,
          startIndex,
          endIndex,
        });
        if (raw === null) continue;
        const rejections = runtimeAlternativeRejections({
          input,
          raw,
          compiled,
          context,
          searchStartIndex: startIndex,
        });
        if (rejections.length === 0) return raw;
        for (const rejection of rejections) {
          const next = applyRuntimeAlternativeRejection({ state, rejection });
          if (next === undefined) continue;
          const key = runtimeAlternativeStateKey({ state: next });
          if (queued.has(key)) continue;
          queued.add(key);
          queue.push(next);
          if (compiled.prioritizeEarlyRuntimeAlternativeRejections) break;
        }
      }
    }
    return null;
  };

  let candidateSearchIndex = searchIndex;
  while (candidateSearchIndex <= input.length) {
    const queue: JqRuntimeAlternativeState[] = [
      initialRuntimeAlternativeState(),
    ];
    const queued = new Set([runtimeAlternativeStateKey({ state: queue[0]! })]);
    let rejectedStart: number | undefined;
    let rejectedEnd: number | undefined;
    let sawShorterEndRejection = false;
    const searchStartCodePointIndex = compiled.positionAssertions.some(
      (assertion) => assertion.kind === "search-start",
    )
      ? jqSearchStartCodePointIndex({
        context,
        codeUnitIndex: candidateSearchIndex,
      })
      : undefined;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      if (queueIndex >= JQ_MAX_RUNTIME_ALTERNATIVE_STATES) {
        throw new JqRegularExpressionRuntimeError(
          "regular expression runtime alternatives exceed the safe limit",
        );
      }
      const state = queue[queueIndex]!;
      const regex = getRegex({
        state,
        sticky: requiredStartIndex !== undefined || rejectedStart !== undefined,
        searchStartCodePointIndex,
      });
      regex.lastIndex = requiredStartIndex ?? rejectedStart ?? candidateSearchIndex;
      const raw = regex.exec(input) as RegExpExecArrayWithIndices | null;
      if (raw === null) continue;
      if (requiredStartIndex !== undefined && raw.index !== requiredStartIndex) continue;
      if (rejectedStart !== undefined && raw.index !== rejectedStart) continue;
      rejectedStart ??= raw.index;
      rejectedEnd ??= raw.indices[0]?.[1];
      const wholeRange = raw.indices[0];
      if (
        requireNonEmpty &&
        wholeRange !== undefined &&
        wholeRange[0] === wholeRange[1]
      ) {
        continue;
      }
      const rejections = runtimeAlternativeRejections({
        input,
        raw,
        compiled,
        context,
        searchStartIndex: candidateSearchIndex,
      });
      if (rejections.length === 0) {
        if (
          compiled.prioritizeEarlyRuntimeAlternativeRejections &&
          (preferNonEmptyAtSearchStart || sawShorterEndRejection) &&
          wholeRange !== undefined &&
          wholeRange[0] === wholeRange[1] &&
          wholeRange[0] === candidateSearchIndex &&
          rejectedEnd !== undefined &&
          rejectedEnd > wholeRange[1]
        ) {
          continue;
        }
        return raw;
      }
      if (
        compiled.prioritizeEarlyRuntimeAlternativeRejections &&
        rejections.some((rejection) =>
          runtimeAlternativeRejectionMayNeedShorterEnd({ rejection })
        )
      ) {
        sawShorterEndRejection = true;
      }
      const nextStates: JqRuntimeAlternativeState[] = [];
      for (const rejection of rejections) {
        const next = applyRuntimeAlternativeRejection({ state, rejection });
        if (next === undefined) continue;
        const key = runtimeAlternativeStateKey({ state: next });
        if (queued.has(key)) continue;
        queued.add(key);
        nextStates.push(next);
        if (compiled.prioritizeEarlyRuntimeAlternativeRejections) break;
      }
      if (compiled.prioritizeEarlyRuntimeAlternativeRejections) {
        // The bounded history fallback unrolls independent nullable repetitions.
        // Resolve one earliest rejected branch at a time so later invalid suffixes
        // do not form a breadth-first power set before native backtracking can
        // expose the next actionable marker. Preserve the established breadth-
        // first order and complete rejection fan-out for non-fallback expressions.
        queue.splice(queueIndex + 1, 0, ...nextStates);
      } else {
        queue.push(...nextStates);
      }
    }
    if (rejectedStart === undefined) return null;
    if (rejectedEnd !== undefined) {
      const shorter = findValidAtShorterEnd({
        startIndex: rejectedStart,
        beforeEndIndex: rejectedEnd,
        searchStartCodePointIndex,
      });
      if (shorter !== null) return shorter;
    }
    if (requiredStartIndex !== undefined) return null;
    candidateSearchIndex = advanceAfterEmptyMatch({
      input,
      index: rejectedStart,
    });
  }
  return null;
}

function selectLongestBackreferenceMatches({
  input,
  compiled,
  global,
  context,
}: {
  input: string;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
  global: boolean;
  context: JqRegularExpressionRuntimeValidationContext;
}): readonly RegExpExecArrayWithIndices[] {
  let fallbackEvaluationCount = 0;
  const regexByState = new Map<string, RegExp>();
  const utf8ByteOffsets = buildJqUtf8ByteOffsets({ input });

  const selectBestCandidateAtSameStart = ({
    candidates,
  }: {
    candidates: readonly RegExpExecArrayWithIndices[];
  }): RegExpExecArrayWithIndices | undefined => {
    let selected: RegExpExecArrayWithIndices | undefined;
    let selectedByteLength = -1;
    for (const candidate of candidates) {
      const range = candidate.indices[0];
      if (
        range === undefined ||
        (compiled.ignoreEmpty && range[0] === range[1])
      ) {
        continue;
      }
      const byteLength = jqUtf8ByteLengthBetween({
        input,
        offsets: utf8ByteOffsets,
        start: range[0],
        end: range[1],
      });
      if (byteLength <= selectedByteLength) continue;
      selected = candidate;
      selectedByteLength = byteLength;
    }
    return selected;
  };

  const createRuntimeRegex = ({
    state,
    searchStartIndex,
  }: {
    state: JqRuntimeAlternativeState;
    searchStartIndex: number | undefined;
  }): RegExp => {
    const key = `${searchStartIndex ?? "-"}:${runtimeAlternativeStateKey({ state })}`;
    const existing = regexByState.get(key);
    if (existing !== undefined) return existing;
    const base = compiled.create({
      global: false,
      disabledBackreferenceAlternatives: state.disabled,
      disabledPhysicalCaptures: state.disabledPhysicalCaptures,
      caseFoldedBackreferenceLengthConstraints:
        state.caseFoldedBackreferenceLengthConstraints,
      preferLongestBackreferenceCandidates: true,
      searchStartCodePointIndex: searchStartIndex === undefined
        ? undefined
        : jqSearchStartCodePointIndex({
          context,
          codeUnitIndex: searchStartIndex,
        }),
    });
    const created = new RegExp(
      base.source,
      `${withoutStatefulFlags({ flags: base.flags })}y`,
    );
    regexByState.set(key, created);
    return created;
  };

  const findPrimaryLongestCandidateAtStart = ({
    regex,
    startIndex,
  }: {
    regex: RegExp;
    startIndex: number;
  }): RegExpExecArrayWithIndices | null => {
    if (hasAlternationOrLazyQuantifier({ source: regex.source })) {
      return findLongestMatchAtStart({ input, regex, startIndex });
    }
    regex.lastIndex = startIndex;
    const raw = regex.exec(input) as RegExpExecArrayWithIndices | null;
    return raw?.index === startIndex ? raw : null;
  };

  const enqueueFirstActionableRejection = ({
    state,
    rejections,
    queue,
    queued,
  }: {
    state: JqRuntimeAlternativeState;
    rejections: readonly JqRuntimeAlternativeRejection[];
    queue: JqRuntimeAlternativeState[];
    queued: Set<string>;
  }): void => {
    // A single syntactic candidate can expose invalid markers from every
    // physically expanded recursion depth. Forking once per marker enumerates
    // their power set even though the next retry only needs to correct one
    // participating marker. Marker constraints leave paths where that marker
    // is absent untouched; later candidates expose any remaining rejection.
    for (const rejection of rejections) {
      const next = applyRuntimeAlternativeRejection({ state, rejection });
      if (next === undefined) continue;
      const key = runtimeAlternativeStateKey({ state: next });
      if (queued.has(key)) continue;
      queued.add(key);
      queue.push(next);
      return;
    }
  };

  const collectValidCandidatesAtStart = ({
    startIndex,
    searchStartIndex,
  }: {
    startIndex: number;
    searchStartIndex: number | undefined;
  }): {
    readonly candidates: readonly RegExpExecArrayWithIndices[];
    readonly sawShorterEndRejection: boolean;
  } => {
    const queue: JqRuntimeAlternativeState[] = [
      initialRuntimeAlternativeState(),
    ];
    const queued = new Set([runtimeAlternativeStateKey({ state: queue[0]! })]);
    const validCandidates: RegExpExecArrayWithIndices[] = [];
    const candidateKeys = new Set<string>();
    let sawShorterEndRejection = false;

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      if (queueIndex >= JQ_MAX_RUNTIME_ALTERNATIVE_STATES) {
        throw new JqRegularExpressionRuntimeError(
          "regular expression runtime alternatives exceed the safe limit",
        );
      }
      const state = queue[queueIndex]!;
      const regex = createRuntimeRegex({ state, searchStartIndex });
      const raw = findPrimaryLongestCandidateAtStart({ regex, startIndex });
      if (raw === null) continue;
      const rejections = runtimeAlternativeRejections({
        input,
        raw,
        compiled,
        context,
        searchStartIndex,
      });
      if (rejections.length === 0) {
        const key = raw.indices
          .map((range) =>
            range === undefined ? "-" : `${range[0]}:${range[1]}`,
          )
          .join(",");
        if (!candidateKeys.has(key)) {
          candidateKeys.add(key);
          validCandidates.push(raw);
        }
        continue;
      }
      if (rejections.some((rejection) =>
        runtimeAlternativeRejectionMayNeedShorterEnd({ rejection })
      )) {
        sawShorterEndRejection = true;
      }
      enqueueFirstActionableRejection({ state, rejections, queue, queued });
    }
    return {
      candidates: validCandidates,
      sawShorterEndRejection,
    };
  };

  const findShorterValidCandidateAtStart = ({
    startIndex,
    beforeEndIndex,
    searchStartIndex,
  }: {
    startIndex: number;
    beforeEndIndex: number;
    searchStartIndex: number | undefined;
  }): RegExpExecArrayWithIndices | undefined => {
    const candidateEnds = jqCandidateEndIndexes({ input, startIndex });
    for (
      let candidateIndex = candidateEnds.length - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const endIndex = candidateEnds[candidateIndex]!;
      if (endIndex >= beforeEndIndex) continue;
      const queue: JqRuntimeAlternativeState[] = [
        initialRuntimeAlternativeState(),
      ];
      const queued = new Set([
        runtimeAlternativeStateKey({ state: queue[0]! }),
      ]);
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
        if (
          queueIndex >= JQ_MAX_RUNTIME_ALTERNATIVE_STATES ||
          fallbackEvaluationCount >= JQ_MAX_RUNTIME_FALLBACK_EVALUATIONS
        ) {
          throw new JqRegularExpressionRuntimeError(
            "regular expression runtime fallback exceeds the safe limit",
          );
        }
        fallbackEvaluationCount += 1;
        const state = queue[queueIndex]!;
        const raw = findMatchAtStartEndingAt({
          input,
          regex: createRuntimeRegex({ state, searchStartIndex }),
          startIndex,
          endIndex,
        });
        if (raw === null) continue;
        const rejections = runtimeAlternativeRejections({
          input,
          raw,
          compiled,
          context,
          searchStartIndex,
        });
        if (rejections.length === 0) return raw;
        enqueueFirstActionableRejection({ state, rejections, queue, queued });
      }
    }
    return undefined;
  };

  const collectCandidatesForSearchStart = ({
    searchStartIndex,
  }: {
    searchStartIndex: number | undefined;
  }): readonly RegExpExecArrayWithIndices[] => {
    const startSearch = compiled.create({
      global: true,
      preferLongestBackreferenceCandidates: true,
      searchStartCodePointIndex: searchStartIndex === undefined
        ? undefined
        : jqSearchStartCodePointIndex({
          context,
          codeUnitIndex: searchStartIndex,
        }),
    });
    const candidates: RegExpExecArrayWithIndices[] = [];
    const unresolvedStarts: {
      readonly startIndex: number;
      readonly beforeEndIndex: number;
    }[] = [];
    let nextSearchIndex = searchStartIndex ?? 0;
    while (nextSearchIndex <= input.length) {
      startSearch.lastIndex = nextSearchIndex;
      const syntactic = startSearch.exec(input) as
        RegExpExecArrayWithIndices | null;
      if (syntactic === null) break;
      const startIndex = syntactic.index;
      const {
        candidates: validAtStart,
        sawShorterEndRejection,
      } = collectValidCandidatesAtStart({
        startIndex,
        searchStartIndex,
      });
      const bestAtStart = selectBestCandidateAtSameStart({
        candidates: validAtStart,
      });
      if (bestAtStart !== undefined) {
        const range = bestAtStart.indices[0];
        if (
          (
            compiled.prioritizeEarlyRuntimeAlternativeRejections ||
            !global
          ) &&
          sawShorterEndRejection
        ) {
          const longestSyntactic = findPrimaryLongestCandidateAtStart({
            regex: startSearch,
            startIndex,
          });
          const syntacticRange = longestSyntactic?.indices[0];
          if (
            syntacticRange !== undefined &&
            range !== undefined &&
            syntacticRange[1] > range[1]
          ) {
            unresolvedStarts.push({
              startIndex,
              beforeEndIndex: syntacticRange[1],
            });
          }
        }
        candidates.push(bestAtStart);
        if (
          unresolvedStarts.length === 0 &&
          candidates.length === 1 &&
          range?.[0] === (searchStartIndex ?? 0) &&
          range[1] === input.length
        ) {
          // No later non-empty start can beat a match spanning the complete
          // remaining input. jq's global longest mode can still emit a
          // trailing empty match at the input end, so preserve that candidate
          // before returning early.
          if (global && range[0] !== range[1]) {
            const endCandidates = collectValidCandidatesAtStart({
              startIndex: input.length,
              searchStartIndex,
            }).candidates;
            const endMatch = selectBestCandidateAtSameStart({
              candidates: endCandidates,
            });
            const endRange = endMatch?.indices[0];
            if (
              endMatch !== undefined &&
              endRange?.[0] === input.length &&
              endRange[1] === input.length
            ) {
              candidates.push(endMatch);
            }
          }
          return candidates;
        }
      } else if (
        sawShorterEndRejection ||
        hasAlternationOrLazyQuantifier({ source: startSearch.source })
      ) {
        const longestSyntactic = findPrimaryLongestCandidateAtStart({
          regex: startSearch,
          startIndex,
        });
        const range = longestSyntactic?.indices[0];
        if (range !== undefined) {
          unresolvedStarts.push({
            startIndex,
            beforeEndIndex: range[1],
          });
        }
      }
      nextSearchIndex = advanceAfterEmptyMatch({ input, index: startIndex });
    }

    for (const unresolved of unresolvedStarts) {
      const fallback = findShorterValidCandidateAtStart({
        ...unresolved,
        searchStartIndex,
      });
      if (fallback !== undefined) candidates.push(fallback);
    }
    return candidates;
  };

  const hasSearchStartAssertion = compiled.positionAssertions.some(
    (assertion) => assertion.kind === "search-start",
  );
  if (hasSearchStartAssertion) {
    const selected: RegExpExecArrayWithIndices[] = [];
    let searchStartIndex = 0;
    while (searchStartIndex <= input.length) {
      const [best] = rankLongestMatches({
        input,
        rawCandidates: collectCandidatesForSearchStart({ searchStartIndex }),
        global: false,
        ignoreEmpty: compiled.ignoreEmpty,
      });
      if (best === undefined) break;
      selected.push(best);
      if (!global) break;
      const range = best.indices[0];
      if (range === undefined) break;
      searchStartIndex = range[1] > range[0]
        ? range[1]
        : advanceAfterEmptyMatch({ input, index: range[1] });
    }
    return selected;
  }

  return rankLongestMatches({
    input,
    rawCandidates: collectCandidatesForSearchStart({
      searchStartIndex: undefined,
    }),
    global,
    ignoreEmpty: compiled.ignoreEmpty,
  });
}

function allowsUniformSevenCodePointCaptureHistoryReplay({
  compatiblePatternMode,
  global,
  ignoreCase,
  longest,
  hasCaseFoldedBackreference,
}: {
  compatiblePatternMode: boolean;
  global: boolean;
  ignoreCase: boolean;
  longest: boolean;
  hasCaseFoldedBackreference: boolean;
}): boolean {
  return compatiblePatternMode &&
    !longest &&
    !(global && (ignoreCase || hasCaseFoldedBackreference));
}

function boundedSimpleCaptureHistoryInputCodePointLength({
  input,
  allowUniformSevenCodePoints,
  allowSingletonRequiredSevenCodePoints,
}: {
  input: string;
  allowUniformSevenCodePoints: boolean;
  allowSingletonRequiredSevenCodePoints: boolean;
}): number | undefined {
  let length = 0;
  let firstCodePoint: string | undefined;
  let uniform = true;
  for (const codePoint of input) {
    length += 1;
    firstCodePoint ??= codePoint;
    if (codePoint !== firstCodePoint) uniform = false;
    if (
      length >
        JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_UNIFORM_INPUT_CODE_POINTS
    ) return undefined;
  }
  if (
    length <=
      JQ_MAX_NULLABLE_UNBOUNDED_SIMPLE_CAPTURE_HISTORY_INPUT_CODE_POINTS
  ) return length;
  return allowSingletonRequiredSevenCodePoints
    || (allowUniformSevenCodePoints && uniform)
    ? length
    : undefined;
}

function boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
  input,
  longest,
}: {
  input: string;
  longest: boolean;
}): number | undefined {
  const staticMarkerBudget = longest
    ? JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_RUNTIME_MARKERS
    : JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_RUNTIME_MARKERS;
  let length = 0;
  for (const _codePoint of input) {
    length += 1;
    if (length > JQ_MAX_DYNAMIC_LINEAR_RUNTIME_CAPTURE_HISTORY_INPUT_CODE_POINTS) {
      return undefined;
    }
  }
  if (length <= staticMarkerBudget) return undefined;
  return length;
}

function boundedPlainCaptureHistoryInputCodePointLength({
  input,
  longest,
}: {
  input: string;
  longest: boolean;
}): number | undefined {
  const staticWindow = longest
    ? JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_LONGEST_PLAIN_REPETITIONS
    : JQ_MAX_UNBOUNDED_CAPTURE_HISTORY_PLAIN_REPETITIONS;
  let length = 0;
  for (const _codePoint of input) {
    length += 1;
    if (length > JQ_MAX_DYNAMIC_PLAIN_CAPTURE_HISTORY_INPUT_CODE_POINTS) {
      return undefined;
    }
  }
  return length > staticWindow ? length : undefined;
}

export function collectJqRegularExpressionMatches({
  input,
  compiled,
  global,
}: {
  input: string;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
  global: boolean;
}): readonly JqRegularExpressionMatch[] {
  switch (compiled.specialMode) {
  case "none":
    break;
  case "grapheme":
  case "grapheme-one-or-more":
  case "grapheme-boundary":
  case "non-grapheme-boundary":
    return collectJqSpecialRegularExpressionMatches({
      input,
      mode: compiled.specialMode,
      global,
      longest: compiled.longest,
      ignoreEmpty: compiled.ignoreEmpty,
    });
  default: {
    const _ex: never = compiled.specialMode;
    throw new Error(`Unhandled special regular expression mode: ${_ex}`);
  }
  }
  const hasCaseFoldedBackreference = compiled.backreferenceAlternatives.some(
    ({ comparison }) => comparison === "case-folded",
  );
  const boundedHistoryInputCodePointLength =
    compiled.compileBoundedSimpleCaptureHistoryFallback === undefined
      ? undefined
      : boundedSimpleCaptureHistoryInputCodePointLength({
        input,
        allowUniformSevenCodePoints:
          allowsUniformSevenCodePointCaptureHistoryReplay({
            compatiblePatternMode:
              compiled.uniformSevenCodePointCaptureHistoryReplayCompatible,
            global,
            ignoreCase: compiled.ignoreCase,
            longest: compiled.longest,
            hasCaseFoldedBackreference,
          }),
        allowSingletonRequiredSevenCodePoints:
          compiled.singletonRequiredSevenCodePointCaptureHistoryReplayCompatible
          && !compiled.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
      });
  if (
    compiled.compileBoundedSimpleCaptureHistoryFallback !== undefined &&
    boundedHistoryInputCodePointLength !== undefined
  ) {
    const guardedBaselineMatches =
      compiled.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay
        ? collectJqRegularExpressionMatches({
          input,
          compiled: {
            ...compiled,
            compileBoundedSimpleCaptureHistoryFallback: undefined,
          },
          global,
        })
        : undefined;
    if (
      guardedBaselineMatches !== undefined
      && guardedBaselineMatches.every((match) =>
        match.captures.every((capture) => capture.text !== null)
      )
    ) {
      return guardedBaselineMatches;
    }

    const fallback = compiled.compileBoundedSimpleCaptureHistoryFallback({
      maximumRepetitions: boundedHistoryInputCodePointLength + 1,
    });
    if (fallback.ok) {
      try {
        const fallbackMatches = collectJqRegularExpressionMatches({
          input,
          compiled: fallback,
          global,
        });
        if (fallbackMatches.length !== 0) {
          if (!compiled.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay) {
            return fallbackMatches;
          }
          const baselineMatches = guardedBaselineMatches ??
            collectJqRegularExpressionMatches({
              input,
              compiled: {
                ...compiled,
                compileBoundedSimpleCaptureHistoryFallback: undefined,
              },
              global,
            });
          const sameWholeMatches =
            fallbackMatches.length === baselineMatches.length
            && fallbackMatches.every((match, index) => {
              const baseline = baselineMatches[index];
              return baseline !== undefined
                && match.start === baseline.start
                && match.end === baseline.end
                && match.text === baseline.text;
            });
          return sameWholeMatches ? fallbackMatches : baselineMatches;
        }
      } catch (error: unknown) {
        // This is an optional compatibility path. If its expanded form reaches an
        // existing state/materialization limit, preserve the bounded native
        // behavior instead of turning a previously valid expression into an
        // error. Unexpected failures still propagate.
        if (!(error instanceof JqRegularExpressionRuntimeError)) throw error;
      }
    }
    if (guardedBaselineMatches !== undefined) return guardedBaselineMatches;
  }

  const expansionAlternations =
    compiled.subexpressionCallExpansionAdditionalAlternationCount;
  const generatedLinearRuntimeCaptureHistoryFallback =
    jqGeneratedLinearRuntimeCaptureHistoryFallbacks.has(compiled);
  if (
    !generatedLinearRuntimeCaptureHistoryFallback &&
    (
      compiled.longest &&
      (
        (
          compiled.recursiveCaptureLogicalIndexes.length === 0 &&
          expansionAlternations >=
            JQ_LONGEST_NONRECURSIVE_SUBEXPRESSION_RETRY_LIMIT_ADDITIONAL_ALTERNATIONS
        ) ||
        (
          compiled.recursiveCaptureLogicalIndexes.length !== 0 &&
          expansionAlternations >=
            JQ_LONGEST_RECURSIVE_SUBEXPRESSION_RETRY_LIMIT_ADDITIONAL_ALTERNATIONS
        )
      )
    )
  ) {
    throw new JqRegularExpressionRuntimeError(
      "Regex failure: retry-limit-in-match over",
    );
  }
  if (
    !generatedLinearRuntimeCaptureHistoryFallback &&
    !compiled.longest &&
    compiled.recursiveCaptureLogicalIndexes.length === 0 &&
    expansionAlternations >=
      JQ_SAFE_SUBEXPRESSION_BACKTRACKING_ADDITIONAL_ALTERNATIONS
  ) {
    throw new JqRegularExpressionRuntimeError(
      "regular expression subexpression expansion exceeds the safe " +
        "backtracking limit",
    );
  }

  const regex = compiled.create({ global: global || compiled.ignoreEmpty });
  const ignoreEmptyAlternatives = compiled.createIgnoreEmptyAlternatives();
  const recursiveUnsafeInput =
    compiled.recursiveCaptureLogicalIndexes.length !== 0 &&
    input.length > JQ_UNSAFE_RECURSIVE_REGEXP_INPUT_LIMIT &&
    hasPotentiallyUnsafeBacktrackingStructure({ source: regex.source });
  if (
    recursiveUnsafeInput ||
    (
      compiled.recursiveCaptureLogicalIndexes.length === 0 &&
      exceedsSafeRegularExpressionInputLimit({ regex, input })
    )
  ) {
    throw new JqRegularExpressionRuntimeError(
      'regular expression input exceeds the safe backtracking limit',
    );
  }
  const boundedPlainHistoryInputCodePointLength =
    compiled.compileBoundedPlainCaptureHistoryFallback === undefined
      ? undefined
      : boundedPlainCaptureHistoryInputCodePointLength({
        input,
        longest: compiled.longest,
      });
  if (
    compiled.compileBoundedPlainCaptureHistoryFallback !== undefined &&
    boundedPlainHistoryInputCodePointLength !== undefined
  ) {
    const fallback = compiled.compileBoundedPlainCaptureHistoryFallback({
      maximumRepetitions: boundedPlainHistoryInputCodePointLength,
    });
    if (fallback.ok) {
      try {
        const fallbackMatches = collectJqRegularExpressionMatches({
          input,
          compiled: fallback,
          global,
        });
        if (fallbackMatches.length !== 0) return fallbackMatches;
      } catch (error: unknown) {
        if (!(error instanceof JqRegularExpressionRuntimeError)) throw error;
      }
    }
  }


  const boundedLinearRuntimeHistoryInputCodePointLength =
    compiled.compileBoundedLinearRuntimeCaptureHistoryFallback === undefined
      ? undefined
      : boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input,
        longest: compiled.longest,
      });
  if (
    compiled.compileBoundedLinearRuntimeCaptureHistoryFallback !== undefined &&
    boundedLinearRuntimeHistoryInputCodePointLength !== undefined
  ) {
    const compileFallback = compiled.compileBoundedLinearRuntimeCaptureHistoryFallback;
    // This history group is proven greedy and non-nullable. Fully bounding it
    // to the input's code-point length therefore cannot exclude a possible
    // match: every repetition must consume at least one input code point.
    const fullyBoundedFallback = compileFallback({
      maximumRepetitions: boundedLinearRuntimeHistoryInputCodePointLength,
    });
    if (fullyBoundedFallback.ok) {
      try {
        return collectJqRegularExpressionMatches({
          input,
          compiled: fullyBoundedFallback,
          global,
        });
      } catch (error: unknown) {
        if (!(error instanceof JqRegularExpressionRuntimeError)) throw error;
      }
    }

    // A large pattern can exceed the source budget before a full-input rewrite
    // is materialized. Preserve the previously measured 512-repetition partial
    // fallback in that case, but adopt its metadata only when the original
    // matcher independently selects exactly the same whole-match spans.
    const partialMaximumRepetitions = Math.min(
      boundedLinearRuntimeHistoryInputCodePointLength,
      JQ_MAX_DYNAMIC_LINEAR_RUNTIME_CAPTURE_HISTORY_PARTIAL_REPETITIONS,
    );
    if (partialMaximumRepetitions < boundedLinearRuntimeHistoryInputCodePointLength) {
      const partialFallback = compileFallback({
        maximumRepetitions: partialMaximumRepetitions,
      });
      if (partialFallback.ok) {
        try {
          const fallbackMatches = collectJqRegularExpressionMatches({
            input,
            compiled: partialFallback,
            global,
          });
          const baselineMatches = collectJqRegularExpressionMatches({
            input,
            compiled: {
              ...compiled,
              compileBoundedLinearRuntimeCaptureHistoryFallback: undefined,
            },
            global,
          });
          const sameSpans = fallbackMatches.length === baselineMatches.length &&
            fallbackMatches.every((match, index) => {
              const baseline = baselineMatches[index];
              return baseline !== undefined &&
                match.start === baseline.start &&
                match.end === baseline.end;
            });
          return sameSpans ? fallbackMatches : baselineMatches;
        } catch (error: unknown) {
          if (!(error instanceof JqRegularExpressionRuntimeError)) throw error;
        }
      }
    }
  }

  const matches: JqRegularExpressionMatch[] = [];
  const hasRuntimeAlternatives =
    compiled.backreferenceAlternatives.length !== 0 ||
    compiled.positionAssertions.length !== 0;
  const runtimeValidationContext =
    createJqRegularExpressionRuntimeValidationContext({ input, compiled });
  const longestMatches = compiled.longest
    ? !hasRuntimeAlternatives
      ? selectLongestMatches({
        input,
        regex,
        global,
        ignoreEmpty: compiled.ignoreEmpty,
      })
      : selectLongestBackreferenceMatches({
        input,
        compiled,
        global,
        context: runtimeValidationContext,
      })
    : undefined;
  let longestMatchIndex = 0;
  let searchIndex = 0;
  let previousAcceptedEmptyMatch = false;

  while (true) {
    const rawCandidate: RegExpExecArrayWithIndices | null =
      longestMatches === undefined
        ? !hasRuntimeAlternatives
          ? (regex.exec(input) as RegExpExecArrayWithIndices | null)
          : findFirstValidBackreferenceMatch({
            input,
            compiled,
            searchIndex,
            context: runtimeValidationContext,
            disableEmptyAlternatives: false,
            requiredStartIndex: undefined,
            requireNonEmpty: false,
            preferNonEmptyAtSearchStart: previousAcceptedEmptyMatch,
          })
        : (longestMatches[longestMatchIndex++] ?? null);
    if (rawCandidate === null) break;
    let raw: RegExpExecArrayWithIndices = rawCandidate;
    let wholeRange: [number, number] | undefined = raw.indices[0];
    if (wholeRange === undefined) break;
    if (
      compiled.ignoreEmpty &&
      wholeRange[0] === wholeRange[1] &&
      (compiled.hasIgnoreEmptyAlternatives || ignoreEmptyAlternatives.length !== 0)
    ) {
      const nonEmptyAlternative: RegExpExecArrayWithIndices | null =
        compiled.hasIgnoreEmptyAlternatives
          ? findFirstValidBackreferenceMatch({
            input,
            compiled,
            searchIndex: wholeRange[0],
            context: runtimeValidationContext,
            disableEmptyAlternatives: true,
            requiredStartIndex: wholeRange[0],
            requireNonEmpty: true,
            preferNonEmptyAtSearchStart: false,
          })
          : findFirstNonEmptyAlternativeMatchAtStart({
            input,
            startIndex: wholeRange[0],
            alternatives: ignoreEmptyAlternatives,
          });
      raw = nonEmptyAlternative ?? raw;
      wholeRange = raw.indices[0];
      if (wholeRange === undefined) break;
    }
    const start: number = wholeRange[0];
    const end: number = wholeRange[1];

    const interiorSurrogateEmptyMatch =
      start === end && isInteriorSurrogateBoundary({ input, index: start });
    const consumedBeforeResetEmptyMatch: boolean =
      compiled.ignoreEmpty &&
      start === end &&
      compiled.positionAssertions.some((assertion): boolean => {
        switch (assertion.kind) {
        case "boundary":
        case "non-boundary":
          return false;
        case "search-start": {
          const marker: [number, number] | undefined =
            raw.indices[assertion.markerCaptureIndex];
          return marker !== undefined && marker[0] < start;
        }
        default: {
          const _ex: never = assertion.kind;
          throw new Error(`Unhandled position assertion: ${_ex}`);
        }
        }
      });
    const ignoredEmptyMatch: boolean =
      (compiled.ignoreEmpty && start === end && !consumedBeforeResetEmptyMatch) ||
      interiorSurrogateEmptyMatch;
    if (!ignoredEmptyMatch) {
      const projectedCaptureRanges: ((readonly [number, number]) | undefined)[] =
        Array.from({ length: compiled.captureNames.length });
      const recursiveCaptureLogicalIndexes = new Set(
        compiled.recursiveCaptureLogicalIndexes,
      );
      for (
        let captureIndex = 1;
        captureIndex < raw.indices.length;
        captureIndex += 1
      ) {
        const range = raw.indices[captureIndex];
        const logicalIndex = compiled.captureSlots[captureIndex - 1];
        if (range !== undefined && logicalIndex !== undefined) {
          const current = projectedCaptureRanges[logicalIndex];
          if (
            current === undefined ||
            !recursiveCaptureLogicalIndexes.has(logicalIndex) ||
            range[1] > current[1] ||
            (range[1] === current[1] && range[0] < current[0])
          ) {
            projectedCaptureRanges[logicalIndex] = range;
          }
        }
      }
      if (start === end) {
        for (let logicalIndex = 0; logicalIndex < projectedCaptureRanges.length; logicalIndex += 1) {
          projectedCaptureRanges[logicalIndex] ??= [start, start];
        }
      }
      const captures = projectedCaptureRanges.map((range, captureIndex) => ({
        start: range?.[0] ?? -1,
        end: range?.[1] ?? -1,
        name: compiled.captureNames[captureIndex] ?? null,
        text: range === undefined ? null : input.slice(range[0], range[1]),
      }));
      matches.push({
        start,
        end,
        text: input.slice(start, end),
        captures,
      });

      if (
        global &&
        start === end &&
        shouldDuplicateEmptyMatchAcrossUtf8Bytes({
          input,
          index: end,
          mode: compiled.emptyByteContinuation,
        })
      ) {
        const nextIndex = advanceAfterEmptyMatch({ input, index: end });
        const continuationByteCount = utf8ByteLengthAt({ input, index: end }) - 1;
        const shiftedCaptures = captures.map((capture) => ({
          ...capture,
          start: capture.start === end ? nextIndex : capture.start,
          end: capture.end === end ? nextIndex : capture.end,
        }));
        for (let duplicate = 0; duplicate < continuationByteCount; duplicate += 1) {
          matches.push({
            start: nextIndex,
            end: nextIndex,
            text: "",
            captures: shiftedCaptures,
          });
        }
      }
    }

    if (!global && !ignoredEmptyMatch) break;
    previousAcceptedEmptyMatch = !ignoredEmptyMatch && start === end;
    searchIndex = start === end ? advanceAfterEmptyMatch({ input, index: end }) : end;
    if (
      longestMatches === undefined &&
      !hasRuntimeAlternatives
    ) {
      regex.lastIndex = searchIndex;
    }
  }

  return matches;
}

export function codePointOffset({
  input,
  codeUnitOffset,
}: {
  input: string;
  codeUnitOffset: number;
}): number {
  if (codeUnitOffset < 0) return -1;
  let codePointCount = 0;
  for (let index = 0; index < codeUnitOffset;) {
    const codePoint = input.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    codePointCount += 1;
  }
  return codePointCount;
}

export const TEST_ONLY = {
  allowsUniformSevenCodePointCaptureHistoryReplay,
  rewriteJqTerminalOptionalCaptureHistoryBranches,
  boundedLinearRuntimeCaptureHistoryMaximumRepetitions,
  boundedPlainCaptureHistoryInputCodePointLength,
  boundedSimpleCaptureHistoryInputCodePointLength,
};
