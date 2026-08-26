import { exceedsSafeRegularExpressionInputLimit } from '@/features/wesh/commands/_shared/backtracking-safety';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv } from "@/features/wesh/argv";
import type { StandardArgvParserSpec } from "@/features/wesh/argv";
import {
  compileBasicRegularExpression,
  findPosixLeftmostLongestMatch,
  compileExtendedRegularExpression,
} from "@/features/wesh/commands/_shared/posix-regexp";
import {
  foldAsciiCase,
  resolveCharacterLocaleMode,
  uppercaseAscii,
  type WeshCharacterLocaleMode,
} from "@/features/wesh/commands/_shared/locale";
import {
  writeCommandHelp,
  writeCommandUsageError,
} from "@/features/wesh/commands/_shared/usage";
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from "@/features/wesh/types";
import {
  openFileReadStream,
  openHandleReadStream,
  readAllFileBytes,
  readAllHandleBytes,
} from "@/features/wesh/utils/fs";
import { canonicalizeExistingPath, normalizePath } from "@/features/wesh/path";
import { iterateReadableStreamChunks } from "@/features/wesh/utils/stream";
import { iterateByteRecordEntries } from "@/features/wesh/utils/text-records";
import {
  createBufferedCommandDataWriter,
  decodeCommandDataBytes,
  decodeCommandDataBytesAsSingleByte,
  encodeCommandDataText,
} from "@/features/wesh/commands/_shared/data-codec";

function decodeSedDataBytes({
  bytes,
  characterLocaleMode,
}: {
  bytes: Uint8Array;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case "ascii":
    return decodeCommandDataBytesAsSingleByte({ bytes });
  case "unicode":
    return decodeCommandDataBytes({ bytes });
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

function toSedLocaleText({
  text,
  characterLocaleMode,
}: {
  text: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case "ascii":
    return decodeCommandDataBytesAsSingleByte({
      bytes: encodeCommandDataText({ text }),
    });
  case "unicode":
    return text;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

function fromSedLocaleText({
  text,
  characterLocaleMode,
}: {
  text: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case "ascii": {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index) & 0xff;
    }
    return decodeCommandDataBytes({ bytes });
  }
  case "unicode":
    return text;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sed character locale mode: ${_ex}`);
  }
  }
}

type SedAddress =
  | { kind: "line"; lineNumber: number }
  | { kind: "last" }
  | { kind: "zero" }
  | { kind: "regex"; regex: RegExp }
  | { kind: "lineStep"; first: number; step: number }
  | { kind: "relativeOffset"; count: number }
  | { kind: "relativeModulo"; modulus: number };

interface SedCommandSelection {
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
}

type SedCommand = SedCommandSelection &
  (
    | {
        kind: "substitute";
        regex: RegExp;
        replacement: string;
        occurrence: number;
        replaceFollowing: boolean;
        print: boolean;
        writePath: string | undefined;
      }
    | {
        kind: "translate";
        source: string;
        target: string;
        duplicateSourcePrecedence: "first" | "last";
      }
    | { kind: "append"; text: string | undefined }
    | { kind: "insert"; text: string | undefined }
    | { kind: "change"; text: string | undefined }
    | { kind: "print" }
    | { kind: "printFirst" }
    | { kind: "list"; width: number | undefined }
    | { kind: "lineNumber" }
    | { kind: "hold" }
    | { kind: "holdAppend" }
    | { kind: "get" }
    | { kind: "getAppend" }
    | { kind: "exchange" }
    | { kind: "delete" }
    | { kind: "deleteFirst" }
    | { kind: "next" }
    | { kind: "nextAppend" }
    | { kind: "readFile"; path: string }
    | { kind: "readFileLine"; path: string }
    | { kind: "writeFile"; path: string }
    | { kind: "writeFileFirst"; path: string }
    | { kind: "clear" }
    | { kind: "fileName" }
    | { kind: "quit"; printPattern: boolean; exitCode: number }
    | { kind: "label"; name: string }
    | { kind: "branch"; targetLabel: string | undefined }
    | { kind: "branchIfSubstituted"; targetLabel: string | undefined }
    | { kind: "branchIfNotSubstituted"; targetLabel: string | undefined }
    | { kind: "groupStart"; endIndex: number }
    | { kind: "groupEnd" }
  );

interface SedRangeRuntimeState {
  inRange: boolean;
  rangeStarted: boolean;
  rangeStartLine?: number;
  rangeEndedOnLine?: number;
}

interface SedRuntimeCommand extends SedRangeRuntimeState {
  command: SedCommand;
}

type SedRuntimeExecutableCommand = SedCommandSelection &
  (
    | {
        kind: "substitute";
        regex: RegExp;
        replacement: string;
        occurrence: number;
        replaceFollowing: boolean;
        print: boolean;
        writePath: string | undefined;
      }
    | { kind: "translate"; lookup: Map<string, string> }
    | { kind: "append"; text: string | undefined }
    | { kind: "insert"; text: string | undefined }
    | { kind: "change"; text: string | undefined }
    | { kind: "print" }
    | { kind: "printFirst" }
    | { kind: "list"; width: number | undefined }
    | { kind: "lineNumber" }
    | { kind: "hold" }
    | { kind: "holdAppend" }
    | { kind: "get" }
    | { kind: "getAppend" }
    | { kind: "exchange" }
    | { kind: "delete" }
    | { kind: "deleteFirst" }
    | { kind: "next" }
    | { kind: "nextAppend" }
    | { kind: "readFile"; path: string }
    | { kind: "readFileLine"; path: string }
    | { kind: "writeFile"; path: string }
    | { kind: "writeFileFirst"; path: string }
    | { kind: "clear" }
    | { kind: "fileName" }
    | { kind: "quit"; printPattern: boolean; exitCode: number }
    | { kind: "label"; name: string }
    | { kind: "branch"; targetIndex: number | undefined }
    | { kind: "branchIfSubstituted"; targetIndex: number | undefined }
    | { kind: "branchIfNotSubstituted"; targetIndex: number | undefined }
    | { kind: "groupStart"; targetIndex: number }
    | { kind: "groupEnd" }
  );

interface SedExecutableRuntimeCommand extends SedRangeRuntimeState {
  command: SedRuntimeExecutableCommand;
}

interface SedTextLine {
  line: string;
  hadNewline: boolean;
  sourceName: string;
}

interface SedLineResult {
  actions: SedAction[];
  quitExitCode: number | undefined;
}

interface SedSpace {
  text: string;
  hadNewline: boolean;
}

interface SedOutput {
  text: string;
  hadNewline: boolean;
}

type SedAction =
  | { kind: "output"; output: SedOutput }
  | { kind: "terminatePendingOutput" }
  | { kind: "appendText"; text: string }
  | { kind: "readFile"; path: string; mode: "all" | "line" }
  | { kind: "writeFile"; path: string; output: SedOutput };

interface SedExecutionState {
  holdSpace: SedSpace;
  characterLocaleMode: WeshCharacterLocaleMode;
}

type SedRegularExpressionSyntax = "basic" | "extended";

const SED_EMPTY_IN_PLACE_SUFFIX_SENTINEL = "\0wesh-sed-empty-in-place-suffix";
const SED_SHORT_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "n",
  "r",
  "E",
  "z",
  "u",
  "s",
]);
const SED_SHORT_REQUIRED_VALUE_OPTIONS: ReadonlySet<string> = new Set(["e", "f"]);

function normalizeSedOptionalInPlaceArguments({
  args,
}: {
  args: readonly string[];
}): string[] {
  const normalized: string[] = [];
  let stopParsingOptions = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex]!;
    if (stopParsingOptions) {
      normalized.push(argument);
      continue;
    }

    if (argument === "--") {
      normalized.push(argument);
      stopParsingOptions = true;
      continue;
    }

    if (argument === "--expression" || argument === "--file") {
      normalized.push(argument);
      const value = args[argumentIndex + 1];
      if (value !== undefined) {
        normalized.push(value);
        argumentIndex += 1;
      }
      continue;
    }

    if (argument === "--in-place") {
      normalized.push(`--in-place=${SED_EMPTY_IN_PLACE_SUFFIX_SENTINEL}`);
      continue;
    }

    if (
      argument === "-" ||
      !argument.startsWith("-") ||
      argument.startsWith("--")
    ) {
      normalized.push(argument);
      continue;
    }

    const shortBody = argument.slice(1);
    let handled = false;
    for (let shortIndex = 0; shortIndex < shortBody.length; shortIndex += 1) {
      const short = shortBody[shortIndex]!;
      if (SED_SHORT_FLAG_OPTIONS.has(short)) continue;

      if (SED_SHORT_REQUIRED_VALUE_OPTIONS.has(short)) {
        normalized.push(argument);
        if (shortIndex === shortBody.length - 1) {
          const value = args[argumentIndex + 1];
          if (value !== undefined) {
            normalized.push(value);
            argumentIndex += 1;
          }
        }
        handled = true;
        break;
      }

      if (short === "i") {
        const attachedSuffix = shortBody.slice(shortIndex + 1);
        if (attachedSuffix.length > 0) {
          normalized.push(argument);
        } else {
          const flagPrefix = shortBody.slice(0, shortIndex);
          if (flagPrefix.length > 0) normalized.push(`-${flagPrefix}`);
          normalized.push(`--in-place=${SED_EMPTY_IN_PLACE_SUFFIX_SENTINEL}`);
        }
        handled = true;
        break;
      }

      normalized.push(argument);
      handled = true;
      break;
    }

    if (!handled) normalized.push(argument);
  }

  return normalized;
}

function resolveSedInPlaceRecoveryPath({
  cwd,
  file,
  fullPath,
  suffix,
}: {
  cwd: string;
  file: string;
  fullPath: string;
  suffix: string;
}): string {
  if (!suffix.includes("*")) return `${fullPath}${suffix}`;
  const expandedSuffix = suffix.replaceAll("*", file);
  return expandedSuffix.startsWith("/")
    ? expandedSuffix
    : `${cwd}/${expandedSuffix}`;
}

interface SedParseState {
  syntax: SedRegularExpressionSyntax;
  characterLocaleMode: WeshCharacterLocaleMode;
  nullData: boolean;
  sourceBoundaryIndices: ReadonlySet<number>;
  previousRegex: RegExp | undefined;
  previousCaptureCount: number;
}

function parseLineNumberAddress({
  value,
}: {
  value: string;
}): SedAddress | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const lineNumber = Number.parseInt(value, 10);
  if (lineNumber === 0) {
    return { kind: "zero" };
  }
  return {
    kind: "line",
    lineNumber,
  };
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

function maximumSedReplacementBackreference({
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

function decodeSedSingleCharacterEscape({
  escaped,
}: {
  escaped: string,
}): string | undefined {
  switch (escaped) {
  case 'a': return '\x07';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\x0b';
  default: return undefined;
  }
}

interface SedDecodedEscape {
  value: string;
  lastIndex: number;
}

function decodeSedExtendedEscape({
  source,
  backslashIndex,
}: {
  source: string;
  backslashIndex: number;
}): SedDecodedEscape | undefined {
  const escaped = source[backslashIndex + 1];
  if (escaped === undefined) return undefined;

  const decoded = decodeSedSingleCharacterEscape({ escaped });
  if (decoded !== undefined) {
    return { value: decoded, lastIndex: backslashIndex + 1 };
  }

  if (escaped === "c") {
    const controlled = source[backslashIndex + 2];
    if (controlled === undefined) return undefined;
    const codePoint = controlled.codePointAt(0);
    if (codePoint === undefined) return undefined;
    const normalizedCodePoint = codePoint >= 0x61 && codePoint <= 0x7a
      ? codePoint - 0x20
      : codePoint;
    const byte = normalizedCodePoint ^ 0x40;
    return {
      value: decodeCommandDataBytes({ bytes: Uint8Array.of(byte) }),
      lastIndex: backslashIndex + 2,
    };
  }

  const numericEscape = (() => {
    switch (escaped) {
    case "x":
      return { radix: 16, pattern: /^[0-9A-Fa-f]{1,2}/u };
    case "o":
      return { radix: 8, pattern: /^[0-7]{1,3}/u };
    case "d":
      return { radix: 10, pattern: /^\d{1,3}/u };
    default:
      return undefined;
    }
  })();
  if (numericEscape === undefined) return undefined;

  const match = numericEscape.pattern.exec(source.slice(backslashIndex + 2));
  if (match === null) return undefined;
  const byte = Number.parseInt(match[0], numericEscape.radix) & 0xff;
  return {
    value: decodeCommandDataBytes({ bytes: Uint8Array.of(byte) }),
    lastIndex: backslashIndex + 1 + match[0].length,
  };
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

function resolveSedRegex({
  source,
  state,
  global,
  dotMatchesNewline,
}: {
  source: string;
  state: SedParseState;
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

function applySedRegexModifiers({
  regex,
  ignoreCase,
  multiline,
  state,
}: {
  regex: RegExp;
  ignoreCase: boolean;
  multiline: boolean;
  state: SedParseState;
}): RegExp {
  const flags = new Set(regex.flags);
  if (ignoreCase) flags.add("i");
  if (multiline && !state.nullData) flags.add("m");
  const modified = new RegExp(regex.source, [...flags].join("") || undefined);
  state.previousRegex = cloneSedRegex({ regex: modified, global: false });
  return modified;
}

function readSedRegexOperand({
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

function parseRegexLiteral({
  script,
  index,
  state,
}: {
  script: string;
  index: number;
  state: SedParseState;
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

function parseAddress({
  script,
  index,
  state,
  allowRelative,
}: {
  script: string;
  index: number;
  state: SedParseState;
  allowRelative: boolean;
}):
  | { ok: true; address: SedAddress | undefined; nextIndex: number }
  | { ok: false; message: string } {
  if (script[index] === "$") {
    return {
      ok: true,
      address: { kind: "last" },
      nextIndex: index + 1,
    };
  }

  const stepMatch = script.slice(index).match(/^(\d+)~(\d*)/u);
  if (stepMatch?.[1] !== undefined) {
    const first = Number.parseInt(stepMatch[1], 10);
    const stepText = stepMatch[2] ?? "";
    const step = stepText.length === 0 ? 0 : Number.parseInt(stepText, 10);
    return {
      ok: true,
      address: { kind: "lineStep", first, step },
      nextIndex: index + stepMatch[0].length,
    };
  }

  if (allowRelative && (script[index] === "+" || script[index] === "~")) {
    const operator = script[index];
    let countIndex = index + 1;
    while (script[countIndex] === " " || script[countIndex] === "\t") {
      countIndex += 1;
    }
    const countMatch = script.slice(countIndex).match(/^\d+/u);
    const countText = countMatch?.[0] ?? "";
    const count = countText.length === 0 ? 0 : Number.parseInt(countText, 10);
    return {
      ok: true,
      address: (() => {
        switch (operator) {
        case "+":
          return { kind: "relativeOffset" as const, count };
        case "~":
          return { kind: "relativeModulo" as const, modulus: count };
        default: {
          const _ex: never = operator;
          throw new Error(`Unhandled sed relative address operator: ${_ex}`);
        }
        }
      })(),
      nextIndex: countIndex + countText.length,
    };
  }

  const lineMatch = script.slice(index).match(/^\d+/);
  if (lineMatch?.[0] !== undefined) {
    return {
      ok: true,
      address: parseLineNumberAddress({ value: lineMatch[0] }),
      nextIndex: index + lineMatch[0].length,
    };
  }

  if (script[index] === "/" || script[index] === "\\") {
    const parsed = parseRegexLiteral({ script, index, state });
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      address: { kind: "regex", regex: parsed.regex },
      nextIndex: parsed.nextIndex,
    };
  }

  return {
    ok: true,
    address: undefined,
    nextIndex: index,
  };
}

function isSingleByteSedDelimiter({ delimiter }: { delimiter: string }): boolean {
  return encodeCommandDataText({ text: delimiter }).byteLength === 1;
}

function parseSubstituteCommand({
  script,
  index,
  address,
  rangeEnd,
  negated,
  state,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  state: SedParseState;
}):
  | { ok: true; command: SedCommand; nextIndex: number }
  | { ok: false; message: string } {
  const delimiter = script[index + 1];
  if (delimiter === undefined) {
    return { ok: false, message: "unterminated substitute command" };
  }
  if (!isSingleByteSedDelimiter({ delimiter })) {
    return {
      ok: false,
      message: "delimiter character is not a single-byte character",
    };
  }

  const patternOperand = readSedRegexOperand({
    script,
    index: index + 2,
    delimiter,
    unterminatedMessage: "unterminated substitute command",
    sourceBoundaryIndices: state.sourceBoundaryIndices,
  });
  if (!patternOperand.ok) return patternOperand;

  let cursor = patternOperand.nextIndex;
  const pattern = patternOperand.source;
  let replacement = "";
  let escaped = false;

  escaped = false;
  let replacementTerminated = false;
  while (cursor < script.length) {
    if (state.sourceBoundaryIndices.has(cursor)) {
      return { ok: false, message: "unterminated substitute command" };
    }
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === "\n") {
      return { ok: false, message: "unterminated substitute command" };
    }
    if (!escaped && char === delimiter) {
      replacementTerminated = true;
      cursor += 1;
      break;
    }
    replacement += char;
    escaped = !escaped && char === "\\";
    cursor += 1;
  }

  if (!replacementTerminated) {
    return { ok: false, message: "unterminated substitute command" };
  }

  let replaceFollowing = false;
  let sawGlobal = false;
  let occurrence = 1;
  let print = false;
  let sawPrint = false;
  let ignoreCase = false;
  let multiline = false;
  let writePath: string | undefined;
  let sawOccurrence = false;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined) break;
    if (char === "g") {
      if (sawGlobal) {
        return { ok: false, message: "multiple 'g' options to 's' command" };
      }
      replaceFollowing = true;
      sawGlobal = true;
      cursor += 1;
      continue;
    }
    if (char === "p") {
      if (sawPrint) {
        return { ok: false, message: "multiple 'p' options to 's' command" };
      }
      print = true;
      sawPrint = true;
      cursor += 1;
      continue;
    }
    if (char === "I" || char === "i") {
      ignoreCase = true;
      cursor += 1;
      continue;
    }
    if (char === "M" || char === "m") {
      multiline = true;
      cursor += 1;
      continue;
    }
    if (char === "w") {
      const parsed = parseSedFileOperand({
        script,
        index: cursor + 1,
        command: "w",
      });
      if (!parsed.ok) return parsed;
      writePath = parsed.path;
      cursor = parsed.nextIndex;
      break;
    }
    if (/^\d$/.test(char)) {
      if (sawOccurrence) {
        return { ok: false, message: "multiple number options to s command" };
      }
      const numberMatch = script.slice(cursor).match(/^\d+/);
      if (numberMatch?.[0] === undefined) {
        return { ok: false, message: "invalid substitute occurrence" };
      }
      const parsedOccurrence = Number.parseInt(numberMatch[0], 10);
      if (parsedOccurrence === 0) {
        return { ok: false, message: "invalid substitute occurrence" };
      }
      occurrence = parsedOccurrence;
      sawOccurrence = true;
      cursor += numberMatch[0].length;
      continue;
    }
    break;
  }

  if (script[cursor] === "\r" && script[cursor + 1] === "\n") {
    cursor += 1;
  }

  if (pattern.length === 0 && (ignoreCase || multiline)) {
    return { ok: false, message: "cannot specify modifiers on empty regexp" };
  }

  try {
    const regex = applySedRegexModifiers({
      regex: resolveSedRegex({
        source: pattern,
        state,
        global: true,
        dotMatchesNewline: !multiline,
      }),
      ignoreCase,
      multiline,
      state,
    });
    const maximumBackreference = maximumSedReplacementBackreference({
      replacement,
    });
    if (maximumBackreference > state.previousCaptureCount) {
      return {
        ok: false,
        message: `invalid reference \\${maximumBackreference} on 's' command's RHS`,
      };
    }
    return {
      ok: true,
      command: {
        kind: "substitute",
        address,
        rangeEnd,
        negated,
        regex,
        replacement,
        occurrence,
        replaceFollowing,
        print,
        writePath,
      },
      nextIndex: cursor,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `invalid substitute regex '${pattern}': ${message}`,
    };
  }
}

function parseDelimitedSedText({
  script,
  index,
  label,
  sourceBoundaryIndices,
}: {
  script: string;
  index: number;
  label: string;
  sourceBoundaryIndices: ReadonlySet<number>;
}):
  | { ok: true; text: string; nextIndex: number }
  | { ok: false; message: string } {
  const delimiter = script[index];
  if (delimiter === undefined) {
    return { ok: false, message: `unterminated ${label} command` };
  }
  if (!isSingleByteSedDelimiter({ delimiter })) {
    return {
      ok: false,
      message: "delimiter character is not a single-byte character",
    };
  }

  let cursor = index + 1;
  let text = "";
  let escaped = false;

  while (cursor < script.length) {
    if (sourceBoundaryIndices.has(cursor)) {
      return { ok: false, message: `unterminated ${label} command` };
    }
    const char = script[cursor];
    if (char === undefined) break;
    if (!escaped && char === "\n") {
      return { ok: false, message: `unterminated ${label} command` };
    }
    if (!escaped && char === delimiter) {
      return {
        ok: true,
        text,
        nextIndex: cursor + 1,
      };
    }
    text += char;
    escaped = !escaped && char === "\\";
    cursor += 1;
  }

  return { ok: false, message: `unterminated ${label} command` };
}

function decodeSedTranslateText({
  source,
  delimiter,
}: {
  source: string;
  delimiter: string;
}): string {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== "\\" || index + 1 >= source.length) {
      result += character;
      continue;
    }

    const decoded = decodeSedExtendedEscape({
      source,
      backslashIndex: index,
    });
    if (decoded !== undefined) {
      result += decoded.value;
      index = decoded.lastIndex;
      continue;
    }

    const escaped = source[index + 1]!;
    if (escaped === "c") {
      // GNU sed treats a trailing \c in a y operand as an empty escape.
      // A following character would have been consumed by the extended
      // escape decoder above.
      index += 1;
      continue;
    }
    // GNU sed removes the escape marker for the delimiter, a literal
    // backslash, and otherwise-unknown transliteration escapes alike.
    // Unlike regexp parsing, \b therefore means a literal "b" here.
    result += escaped === delimiter ? delimiter : escaped;
    index += 1;
  }
  return result;
}

function haveEqualCodePointLength({
  left,
  right,
}: {
  left: string;
  right: string;
}): boolean {
  const leftCharacters = left[Symbol.iterator]();
  const rightCharacters = right[Symbol.iterator]();
  while (true) {
    const leftCharacter = leftCharacters.next();
    const rightCharacter = rightCharacters.next();
    if (leftCharacter.done || rightCharacter.done) {
      return leftCharacter.done === rightCharacter.done;
    }
  }
}

function parseTranslateCommand({
  script,
  index,
  address,
  rangeEnd,
  negated,
  characterLocaleMode,
  sourceBoundaryIndices,
}: {
  script: string;
  index: number;
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
  sourceBoundaryIndices: ReadonlySet<number>;
}):
  | { ok: true; command: SedCommand; nextIndex: number }
  | { ok: false; message: string } {
  const source = parseDelimitedSedText({
    script,
    index: index + 1,
    label: "translate",
    sourceBoundaryIndices,
  });
  if (!source.ok) return source;

  const target = parseDelimitedSedText({
    script,
    index: source.nextIndex - 1,
    label: "translate",
    sourceBoundaryIndices,
  });
  if (!target.ok) return target;

  const delimiter = script[index + 1];
  if (delimiter === undefined) {
    return { ok: false, message: "unterminated translate command" };
  }
  const decodedSource = toSedLocaleText({
    text: decodeSedTranslateText({ source: source.text, delimiter }),
    characterLocaleMode,
  });
  const decodedTarget = toSedLocaleText({
    text: decodeSedTranslateText({ source: target.text, delimiter }),
    characterLocaleMode,
  });

  if (!haveEqualCodePointLength({ left: decodedSource, right: decodedTarget })) {
    return {
      ok: false,
      message: "strings for y command are different lengths",
    };
  }

  return {
    ok: true,
    command: {
      kind: "translate",
      address,
      rangeEnd,
      negated,
      source: decodedSource,
      target: decodedTarget,
      duplicateSourcePrecedence: (() => {
        switch (characterLocaleMode) {
        case "unicode":
          return "first";
        case "ascii":
          return "last";
        default: {
          const _ex: never = characterLocaleMode;
          throw new Error(`Unhandled character locale mode: ${_ex}`);
        }
        }
      })(),
    },
    nextIndex: target.nextIndex,
  };
}

function parseTextCommand({
  script,
  index,
  label,
  address,
  rangeEnd,
  negated,
  characterLocaleMode,
}: {
  script: string;
  index: number;
  label: "append" | "insert" | "change";
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
}):
  | { ok: true; command: SedCommand; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index + 1;
  const hasExplicitTextIntroducer = script[cursor] === "\\";
  if (hasExplicitTextIntroducer) {
    cursor += 1;
    if (script[cursor] === "\n") {
      cursor += 1;
    } else if (script[cursor] === undefined) {
      return {
        ok: true,
        command: { kind: label, address, rangeEnd, negated, text: undefined },
        nextIndex: cursor,
      };
    }
  } else {
    while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
    if (script[cursor] === undefined) {
      return { ok: false, message: `expected \\ after '${label[0]}' command` };
    }
  }

  let text = "";
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === undefined || char === "\n") break;
    if (char !== "\\") {
      text += char;
      cursor += 1;
      continue;
    }

    const escaped = script[cursor + 1];
    if (escaped === undefined) {
      cursor += 1;
      break;
    }
    if (escaped === "\n") {
      cursor += 2;
      if (text.length > 0 || cursor < script.length) text += "\n";
      continue;
    }

    const decoded = decodeSedExtendedEscape({
      source: script,
      backslashIndex: cursor,
    });
    if (decoded !== undefined) {
      text += decoded.value;
      cursor = decoded.lastIndex + 1;
      continue;
    }

    text += escaped;
    cursor += 2;
  }

  return {
    ok: true,
    command: {
      kind: label,
      address,
      rangeEnd,
      negated,
      text: toSedLocaleText({ text, characterLocaleMode }),
    },
    nextIndex: cursor,
  };
}

function skipSeparators({
  script,
  index,
}: {
  script: string;
  index: number;
}): number {
  let cursor = index;
  while (cursor < script.length) {
    const char = script[cursor];
    if (char === ";" || char === "\n" || char === " " || char === "\t") {
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function parseOptionalSedNumber({
  script,
  index,
  label,
}: {
  script: string;
  index: number;
  label: string;
}):
  | { ok: true; value: number | undefined; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (/^[0-9]$/.test(script[cursor] ?? "")) cursor += 1;
  if (cursor === start) {
    const trailing = script[cursor];
    if (
      trailing !== undefined &&
      trailing !== ";" &&
      trailing !== "\n" &&
      trailing !== "}" &&
      trailing !== "#"
    ) {
      return { ok: false, message: `invalid ${label} argument` };
    }
    return { ok: true, value: undefined, nextIndex: cursor };
  }
  const valueText = script.slice(start, cursor);
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const trailing = script[cursor];
  if (
    trailing !== undefined &&
    trailing !== ";" &&
    trailing !== "\n" &&
    trailing !== "}" &&
    trailing !== "#"
  ) {
    return { ok: false, message: `invalid ${label} argument` };
  }
  return {
    ok: true,
    value: Number.parseInt(valueText, 10),
    nextIndex: cursor,
  };
}

function isZeroAddress({
  address,
}: {
  address: SedAddress | undefined;
}): boolean {
  if (address === undefined) return false;
  switch (address.kind) {
  case "zero":
    return true;
  case "line":
  case "last":
  case "regex":
  case "lineStep":
  case "relativeOffset":
  case "relativeModulo":
    return false;
  default: {
    const _ex: never = address;
    throw new Error(
      `Unhandled sed address kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
    );
  }
  }
}

function parseSedLabelOperand({
  script,
  index,
  requirement,
}: {
  script: string;
  index: number;
  requirement: "optional" | "required";
}):
  | { ok: true; label: string | undefined; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (
    cursor < script.length &&
    script[cursor] !== ";" &&
    script[cursor] !== "\n" &&
    script[cursor] !== "}" &&
    script[cursor] !== " " &&
    script[cursor] !== "\t" &&
    script[cursor] !== "#"
  )
    cursor += 1;
  const label = script.slice(start, cursor);
  if (label.length === 0) {
    switch (requirement) {
    case "required":
      return { ok: false, message: "empty label name" };
    case "optional":
      return { ok: true, label: undefined, nextIndex: cursor };
    default: {
      const _ex: never = requirement;
      throw new Error(`Unhandled sed label requirement: ${_ex}`);
    }
    }
  }
  return { ok: true, label, nextIndex: cursor };
}

function parseSedFileOperand({
  script,
  index,
  command,
}: {
  script: string;
  index: number;
  command: "r" | "R" | "w" | "W";
}):
  | { ok: true; path: string; nextIndex: number }
  | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const start = cursor;
  while (cursor < script.length && script[cursor] !== "\n") cursor += 1;
  const path = script.slice(start, cursor);
  if (path.length === 0) {
    return { ok: false, message: `missing filename in ${command} command` };
  }
  return { ok: true, path, nextIndex: cursor };
}

function validateSedLabels({
  commands,
}: {
  commands: readonly SedCommand[];
}): { ok: true } | { ok: false; message: string } {
  const labels = new Set<string>();
  for (const command of commands) {
    switch (command.kind) {
    case "label":
      labels.add(command.name);
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "quit":
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while collecting labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }
  for (const command of commands) {
    switch (command.kind) {
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
      if (
        command.targetLabel !== undefined &&
          !labels.has(command.targetLabel)
      ) {
        return {
          ok: false,
          message: `can't find label for jump to '${command.targetLabel}'`,
        };
      }
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "quit":
    case "label":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while validating labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }
  return { ok: true };
}

function validateSedCommandBoundary({
  script,
  index,
}: {
  script: string;
  index: number;
}): { ok: true; nextIndex: number } | { ok: false; message: string } {
  let cursor = index;
  while (script[cursor] === " " || script[cursor] === "\t") cursor += 1;
  const trailing = script[cursor];
  if (
    trailing === undefined
    || trailing === ";"
    || trailing === "\n"
    || trailing === "}"
    || trailing === "#"
  ) {
    return { ok: true, nextIndex: cursor };
  }
  return { ok: false, message: "extra characters after command" };
}

function parseSedScript({
  script,
  state,
}: {
  script: string;
  state: SedParseState;
}): { ok: true; commands: SedCommand[] } | { ok: false; message: string } {
  const commands: SedCommand[] = [];
  const groupStartIndices: number[] = [];
  let index = 0;

  while (index < script.length) {
    index = skipSeparators({ script, index });
    if (index >= script.length) break;

    if (script[index] === "#") {
      while (index < script.length && script[index] !== "\n") index += 1;
      continue;
    }

    const firstAddress = parseAddress({
      script,
      index,
      state,
      allowRelative: false,
    });
    if (!firstAddress.ok) return firstAddress;
    const address = firstAddress.address;
    index = firstAddress.nextIndex;

    let rangeEnd: SedAddress | undefined;
    let rangeSeparatorIndex = index;
    while (
      script[rangeSeparatorIndex] === " " ||
      script[rangeSeparatorIndex] === "\t"
    ) {
      rangeSeparatorIndex += 1;
    }
    if (script[rangeSeparatorIndex] === ",") {
      let rangeAddressIndex = rangeSeparatorIndex + 1;
      while (script[rangeAddressIndex] === " " || script[rangeAddressIndex] === "\t") {
        rangeAddressIndex += 1;
      }
      const secondAddress = parseAddress({
        script,
        index: rangeAddressIndex,
        state,
        allowRelative: true,
      });
      if (!secondAddress.ok || secondAddress.address === undefined) {
        return { ok: false, message: "invalid range address" };
      }
      rangeEnd = secondAddress.address;
      index = secondAddress.nextIndex;
    }

    while (script[index] === " " || script[index] === "\t") index += 1;

    const hasInvalidZeroStep =
      address?.kind === "lineStep" && address.first === 0 && address.step === 0;
    if (hasInvalidZeroStep) {
      return { ok: false, message: "invalid usage of line address 0" };
    }
    if (isZeroAddress({ address }) && rangeEnd === undefined) {
      return { ok: false, message: "invalid usage of line address 0" };
    }
    if (isZeroAddress({ address }) && rangeEnd?.kind !== "regex") {
      return { ok: false, message: "invalid usage of line address 0" };
    }

    let negated = false;
    if (script[index] === "!") {
      negated = true;
      index += 1;
      while (script[index] === " " || script[index] === "\t") index += 1;
    }

    const commandChar = script[index];
    if (commandChar === undefined) break;

    let requiresCommandBoundary = true;
    switch (commandChar) {
    case "s": {
      const parsed = parseSubstituteCommand({
        script,
        index,
        address,
        rangeEnd,
        negated,
        state,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "p":
      commands.push({ kind: "print", address, rangeEnd, negated });
      index += 1;
      break;
    case "P":
      commands.push({ kind: "printFirst", address, rangeEnd, negated });
      index += 1;
      break;
    case "l": {
      const parsed = parseOptionalSedNumber({
        script,
        index: index + 1,
        label: "list width",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "list",
        address,
        rangeEnd,
        negated,
        width: parsed.value,
      });
      index = parsed.nextIndex;
      break;
    }
    case "=":
      commands.push({ kind: "lineNumber", address, rangeEnd, negated });
      index += 1;
      break;
    case "h":
      commands.push({ kind: "hold", address, rangeEnd, negated });
      index += 1;
      break;
    case "H":
      commands.push({ kind: "holdAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "g":
      commands.push({ kind: "get", address, rangeEnd, negated });
      index += 1;
      break;
    case "G":
      commands.push({ kind: "getAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "x":
      commands.push({ kind: "exchange", address, rangeEnd, negated });
      index += 1;
      break;
    case "d":
      commands.push({ kind: "delete", address, rangeEnd, negated });
      index += 1;
      break;
    case "D":
      commands.push({ kind: "deleteFirst", address, rangeEnd, negated });
      index += 1;
      break;
    case "n":
      commands.push({ kind: "next", address, rangeEnd, negated });
      index += 1;
      break;
    case "N":
      commands.push({ kind: "nextAppend", address, rangeEnd, negated });
      index += 1;
      break;
    case "r":
    case "R":
    case "w":
    case "W": {
      const parsed = parseSedFileOperand({
        script,
        index: index + 1,
        command: commandChar,
      });
      if (!parsed.ok) return parsed;
      const selection = { address, rangeEnd, negated };
      switch (commandChar) {
      case "r":
        commands.push({
          kind: "readFile",
          ...selection,
          path: parsed.path,
        });
        break;
      case "R":
        commands.push({
          kind: "readFileLine",
          ...selection,
          path: parsed.path,
        });
        break;
      case "w":
        commands.push({
          kind: "writeFile",
          ...selection,
          path: parsed.path,
        });
        break;
      case "W":
        commands.push({
          kind: "writeFileFirst",
          ...selection,
          path: parsed.path,
        });
        break;
      default: {
        const _ex: never = commandChar;
        throw new Error(`Unhandled sed file command: ${_ex}`);
      }
      }
      index = parsed.nextIndex;
      break;
    }
    case "z":
      commands.push({ kind: "clear", address, rangeEnd, negated });
      index += 1;
      break;
    case "F":
      commands.push({ kind: "fileName", address, rangeEnd, negated });
      index += 1;
      break;
    case "q":
    case "Q": {
      if (rangeEnd !== undefined) {
        return { ok: false, message: "command only uses one address" };
      }
      const parsed = parseOptionalSedNumber({
        script,
        index: index + 1,
        label: "quit status",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "quit",
        address,
        rangeEnd,
        negated,
        printPattern: commandChar === "q",
        exitCode: parsed.value ?? 0,
      });
      index = parsed.nextIndex;
      break;
    }
    case ":": {
      if (address !== undefined || rangeEnd !== undefined || negated) {
        return { ok: false, message: ": doesn't want any addresses" };
      }
      const parsed = parseSedLabelOperand({
        script,
        index: index + 1,
        requirement: "required",
      });
      if (!parsed.ok) return parsed;
      commands.push({
        kind: "label",
        address: undefined,
        rangeEnd: undefined,
        negated: false,
        name: parsed.label!,
      });
      index = parsed.nextIndex;
      requiresCommandBoundary = false;
      break;
    }
    case "b":
    case "t":
    case "T": {
      const parsed = parseSedLabelOperand({
        script,
        index: index + 1,
        requirement: "optional",
      });
      if (!parsed.ok) return parsed;
      const selection = { address, rangeEnd, negated };
      switch (commandChar) {
      case "b":
        commands.push({
          kind: "branch",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      case "t":
        commands.push({
          kind: "branchIfSubstituted",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      case "T":
        commands.push({
          kind: "branchIfNotSubstituted",
          ...selection,
          targetLabel: parsed.label,
        });
        break;
      default: {
        const _ex: never = commandChar;
        throw new Error(`Unhandled sed branch command: ${_ex}`);
      }
      }
      index = parsed.nextIndex;
      requiresCommandBoundary = false;
      break;
    }
    case "{": {
      const startIndex = commands.length;
      commands.push({
        kind: "groupStart",
        address,
        rangeEnd,
        negated,
        endIndex: -1,
      });
      groupStartIndices.push(startIndex);
      index += 1;
      requiresCommandBoundary = false;
      break;
    }
    case "}": {
      if (address !== undefined || rangeEnd !== undefined || negated) {
        return { ok: false, message: "unexpected '}'" };
      }
      const startIndex = groupStartIndices.pop();
      if (startIndex === undefined)
        return { ok: false, message: "unexpected '}'" };
      const startCommand = commands[startIndex];
      if (startCommand === undefined)
        throw new Error("Invalid sed group parser state");
      switch (startCommand.kind) {
      case "groupStart":
        startCommand.endIndex = commands.length;
        break;
      case "substitute":
      case "translate":
      case "append":
      case "insert":
      case "change":
      case "print":
      case "printFirst":
      case "lineNumber":
      case "list":
      case "clear":
      case "fileName":
      case "hold":
      case "holdAppend":
      case "get":
      case "getAppend":
      case "exchange":
      case "delete":
      case "deleteFirst":
      case "next":
      case "nextAppend":
      case "readFile":
      case "readFileLine":
      case "writeFile":
      case "writeFileFirst":
      case "quit":
      case "label":
      case "branch":
      case "branchIfSubstituted":
      case "branchIfNotSubstituted":
      case "groupEnd":
        throw new Error("Invalid sed group parser state");
      default: {
        const _ex: never = startCommand;
        throw new Error(
          `Unhandled sed command in group parser: ${JSON.stringify(_ex)}`,
        );
      }
      }
      commands.push({
        kind: "groupEnd",
        address: undefined,
        rangeEnd: undefined,
        negated: false,
      });
      index += 1;
      break;
    }
    case "y": {
      const parsed = parseTranslateCommand({
        script,
        index,
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
        sourceBoundaryIndices: state.sourceBoundaryIndices,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "a": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "append",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "i": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "insert",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    case "c": {
      const parsed = parseTextCommand({
        script,
        index,
        label: "change",
        address,
        rangeEnd,
        negated,
        characterLocaleMode: state.characterLocaleMode,
      });
      if (!parsed.ok) return parsed;
      commands.push(parsed.command);
      index = parsed.nextIndex;
      break;
    }
    default:
      return {
        ok: false,
        message: `unsupported sed command '${commandChar}'`,
      };
    }

    if (requiresCommandBoundary) {
      const boundary = validateSedCommandBoundary({ script, index });
      if (!boundary.ok) return boundary;
      index = boundary.nextIndex;
    }
  }

  if (groupStartIndices.length > 0) {
    return { ok: false, message: "unmatched '{'" };
  }

  return { ok: true, commands };
}

function matchesAddress({
  address,
  lineNumber,
  line,
  isLastLine,
}: {
  address: SedAddress | undefined;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  if (address === undefined) return true;

  switch (address.kind) {
  case "line":
    return lineNumber === address.lineNumber;
  case "last":
    return isLastLine;
  case "zero":
    return false;
  case "regex":
    if (exceedsSafeRegularExpressionInputLimit({ regex: address.regex, input: line })) {
      throw new Error('sed: regular expression input exceeds the safe backtracking limit');
    }
    address.regex.lastIndex = 0;
    return address.regex.test(line);
  case "lineStep":
    if (address.step === 0) return lineNumber === address.first;
    if (address.first === 0) return lineNumber % address.step === 0;
    return lineNumber >= address.first && (lineNumber - address.first) % address.step === 0;
  case "relativeOffset":
  case "relativeModulo":
    throw new Error("Relative sed addresses are valid only as range endings");
  default: {
    const _ex: never = address;
    throw new Error(`Unhandled sed address kind: ${_ex}`);
  }
  }
}

function matchesRangeEndAddress({
  runtimeCommand,
  lineNumber,
  line,
  isLastLine,
}: {
  runtimeCommand: SedRuntimeCommand | SedExecutableRuntimeCommand;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  const endAddress = runtimeCommand.command.rangeEnd;
  if (endAddress === undefined) return false;

  switch (endAddress.kind) {
  case "relativeOffset": {
    const startLine = runtimeCommand.rangeStartLine;
    return startLine !== undefined && lineNumber >= startLine + endAddress.count;
  }
  case "relativeModulo": {
    const startLine = runtimeCommand.rangeStartLine;
    if (startLine === undefined) return false;
    if (endAddress.modulus === 0) return lineNumber >= startLine;
    const remainder = startLine % endAddress.modulus;
    const targetLine =
      startLine +
      (remainder === 0
        ? endAddress.modulus
        : endAddress.modulus - remainder);
    return lineNumber >= targetLine;
  }
  case "line":
  case "last":
  case "zero":
  case "regex":
  case "lineStep":
    return matchesAddress({
      address: endAddress,
      lineNumber,
      line,
      isLastLine,
    });
  default: {
    const _ex: never = endAddress;
    throw new Error(`Unhandled sed range end kind: ${_ex}`);
  }
  }
}

function commandApplies({
  runtimeCommand,
  lineNumber,
  line,
  isLastLine,
}: {
  runtimeCommand: SedRuntimeCommand | SedExecutableRuntimeCommand;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  const { command } = runtimeCommand;
  let applies: boolean;
  if (command.rangeEnd === undefined) {
    applies = matchesAddress({
      address: command.address,
      lineNumber,
      line,
      isLastLine,
    });
  } else if (runtimeCommand.inRange) {
    const rangeEnd = command.rangeEnd;
    if (rangeEnd.kind === "line" && lineNumber > rangeEnd.lineNumber) {
      runtimeCommand.inRange = false;
      runtimeCommand.rangeEndedOnLine = rangeEnd.lineNumber;
      applies = false;
    } else {
      if (
        matchesRangeEndAddress({
          runtimeCommand,
          lineNumber,
          line,
          isLastLine,
        })
      ) {
        runtimeCommand.inRange = false;
        runtimeCommand.rangeEndedOnLine = lineNumber;
      }
      applies = true;
    }
  } else if (runtimeCommand.rangeEndedOnLine === lineNumber) {
    applies = true;
  } else {
    const startsRange = (() => {
      const address = command.address;
      if (address === undefined) return true;
      switch (address.kind) {
      case "zero":
        return !runtimeCommand.rangeStarted;
      case "line": {
        if (runtimeCommand.rangeStarted || lineNumber < address.lineNumber)
          return false;
        if (lineNumber === address.lineNumber) return true;
        const rangeEnd = command.rangeEnd;
        return rangeEnd.kind !== "line" || lineNumber <= rangeEnd.lineNumber;
      }
      case "last":
      case "regex":
      case "lineStep":
        return matchesAddress({
          address,
          lineNumber,
          line,
          isLastLine,
        });
      case "relativeOffset":
      case "relativeModulo":
        throw new Error("Relative sed addresses cannot start a range");
      default: {
        const _ex: never = address;
        throw new Error(
          `Unhandled sed range start kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
        );
      }
      }
    })();
    if (!startsRange) {
      applies = false;
    } else {
      if (command.address?.kind === "line" || command.address?.kind === "zero") {
        runtimeCommand.rangeStarted = true;
      }
      runtimeCommand.rangeEndedOnLine = undefined;
      runtimeCommand.rangeStartLine = lineNumber;
      const endAddress = command.rangeEnd;
      const endsOnStartingLine = (() => {
        if (isZeroAddress({ address: command.address })) {
          return matchesAddress({
            address: endAddress,
            lineNumber,
            line,
            isLastLine,
          });
        }
        switch (endAddress.kind) {
        case "regex":
          return false;
        case "lineStep":
          if (endAddress.first === 0 && endAddress.step === 0) return true;
          return matchesAddress({
            address: endAddress,
            lineNumber,
            line,
            isLastLine,
          });
        case "line":
          return lineNumber >= endAddress.lineNumber;
        case "last":
          return isLastLine;
        case "zero":
          return true;
        case "relativeOffset":
          return endAddress.count === 0;
        case "relativeModulo":
          return endAddress.modulus === 0;
        default: {
          const _ex: never = endAddress;
          throw new Error(
            `Unhandled sed range end kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
          );
        }
        }
      })();
      if (!endsOnStartingLine) {
        runtimeCommand.inRange = true;
      }
      applies = true;
    }
  }

  return command.negated ? !applies : applies;
}

function commandNeedsLastLine({
  runtimeCommand,
  lineNumber,
  line,
}: {
  runtimeCommand: SedRuntimeCommand | SedExecutableRuntimeCommand;
  lineNumber: number;
  line: string;
}): boolean {
  const { command } = runtimeCommand;
  const addressNeedsLastLine = (() => {
    const address = command.address;
    if (address === undefined) return false;
    switch (address.kind) {
    case "last":
      return true;
    case "zero":
    case "line":
    case "regex":
    case "lineStep":
      return false;
    case "relativeOffset":
    case "relativeModulo":
      throw new Error("Relative sed addresses cannot start a range");
    default: {
      const _ex: never = address;
      throw new Error(
        `Unhandled sed address kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
      );
    }
    }
  })();

  if (command.rangeEnd === undefined) return addressNeedsLastLine;

  const rangeEndsOnLastLine = (() => {
    const rangeEnd = command.rangeEnd;
    switch (rangeEnd.kind) {
    case "last":
      return true;
    case "zero":
    case "line":
    case "regex":
    case "lineStep":
    case "relativeOffset":
    case "relativeModulo":
      return false;
    default: {
      const _ex: never = rangeEnd;
      throw new Error(
        `Unhandled sed range end kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
      );
    }
    }
  })();

  if (runtimeCommand.inRange) return rangeEndsOnLastLine;
  if (runtimeCommand.rangeEndedOnLine === lineNumber) return false;
  if (addressNeedsLastLine) return true;
  if (!rangeEndsOnLastLine) return false;

  const address = command.address;
  if (address === undefined) return true;
  switch (address.kind) {
  case "last":
    return true;
  case "zero":
    return !runtimeCommand.rangeStarted;
  case "line":
    return !runtimeCommand.rangeStarted && lineNumber >= address.lineNumber;
  case "regex":
  case "lineStep":
    return matchesAddress({
      address,
      lineNumber,
      line,
      isLastLine: false,
    });
  case "relativeOffset":
  case "relativeModulo":
    throw new Error("Relative sed addresses cannot start a range");
  default: {
    const _ex: never = address;
    throw new Error(
      `Unhandled sed range start kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
    );
  }
  }
}

function settleActiveRangeEnds({
  runtimeCommands,
  startIndex,
  endIndex,
  lineNumber,
  line,
  reason,
}: {
  runtimeCommands: readonly SedExecutableRuntimeCommand[];
  startIndex: number;
  endIndex: number;
  lineNumber: number;
  line: string;
  reason: "cycleTermination" | "inputConsumption";
}): void {
  for (let index = startIndex; index < endIndex; index += 1) {
    const runtimeCommand = runtimeCommands[index]!;
    const rangeEnd = runtimeCommand.command.rangeEnd;
    if (!runtimeCommand.inRange || rangeEnd === undefined) continue;
    if (
      rangeEnd.kind === "last" ||
      rangeEnd.kind === "relativeOffset" ||
      rangeEnd.kind === "relativeModulo" ||
      (reason === "inputConsumption" &&
        (rangeEnd.kind === "regex" || rangeEnd.kind === "lineStep"))
    ) {
      continue;
    }
    if (matchesRangeEndAddress({
      runtimeCommand,
      lineNumber,
      line,
      isLastLine: false,
    })) {
      runtimeCommand.inRange = false;
      runtimeCommand.rangeEndedOnLine = lineNumber;
    }
  }
}

async function openSedInputStream({
  context,
  file,
}: {
  context: WeshCommandContext;
  file: string;
}): Promise<ReadableStream<Uint8Array>> {
  if (file === "-") {
    return openHandleReadStream({ handle: context.stdin });
  }

  const path = file.startsWith("/") ? file : `${context.cwd}/${file}`;
  return openFileReadStream({
    files: context.files,
    path,
  });
}

async function* readTextRecords({
  stream,
  sourceName,
  delimiterByte,
  characterLocaleMode,
}: {
  stream: ReadableStream<Uint8Array>;
  sourceName: string;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): AsyncGenerator<SedTextLine> {
  for await (const record of iterateByteRecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte,
  })) {
    yield {
      line: decodeSedDataBytes({
        bytes: record.bytes,
        characterLocaleMode,
      }),
      hadNewline: record.termination === "delimiter",
      sourceName: toSedLocaleText({ text: sourceName, characterLocaleMode }),
    };
  }
}

interface SedOutputWriter {
  write({ output }: { output: SedOutput }): Promise<void>;
  terminatePendingOutput(): Promise<void>;
  writeAppendText({ text }: { text: string }): Promise<void>;
  writeReadFile({
    lines,
    terminatePendingOutputWhenEmpty,
  }: {
    lines: AsyncIterable<SedTextLine> | undefined;
    terminatePendingOutputWhenEmpty: boolean;
  }): Promise<void>;
  flush(): Promise<void>;
}

function parseSedLineLengthOption({ value }: { value: string }): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function renderSedList({
  text,
  width,
  continuationSeparator,
  characterLocaleMode,
}: {
  text: string;
  width: number | undefined;
  continuationSeparator: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  const maximumWidth = width ?? 70;
  const contentWidth = Math.max(0, maximumWidth - 1);
  let output = "";
  let currentLineLength = 0;

  const appendToken = ({ token }: { token: string }): void => {
    if (
      maximumWidth !== 0 &&
      currentLineLength + token.length > contentWidth
    ) {
      output += `\\${continuationSeparator}`;
      currentLineLength = 0;
    }
    output += token;
    currentLineLength += token.length;
  };

  for (const character of text) {
    const token = (() => {
      switch (character) {
      case "\\":
        return "\\\\";
      case "\u0007":
        return "\\a";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\v":
        return "\\v";
      default: {
        const codePoint = character.codePointAt(0);
        if (
          codePoint !== undefined &&
            codePoint >= 0x20 &&
            codePoint <= 0x7e
        ) {
          return character;
        }
        return undefined;
      }
      }
    })();
    if (token !== undefined) {
      appendToken({ token });
      continue;
    }
    switch (characterLocaleMode) {
    case "ascii":
      appendToken({
        token: `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
      });
      break;
    case "unicode":
      for (const byte of encodeCommandDataText({ text: character })) {
        appendToken({
          token: `\\${byte.toString(8).padStart(3, "0")}`,
        });
      }
      break;
    default: {
      const _ex: never = characterLocaleMode;
      throw new Error(`Unhandled sed character locale mode: ${_ex}`);
    }
    }
  }
  output += "$";
  return output;
}


function createSedOutputWriter({
  writer,
  recordTerminator,
  characterLocaleMode,
}: {
  writer: ReturnType<typeof createBufferedCommandDataWriter>;
  recordTerminator: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): SedOutputWriter {
  let previousOutputMissingNewline = false;
  const terminatePendingOutput = async (): Promise<void> => {
    if (!previousOutputMissingNewline) return;
    await writer.write({
      text: fromSedLocaleText({ text: recordTerminator, characterLocaleMode }),
    });
    previousOutputMissingNewline = false;
  };
  return {
    write: async ({ output }) => {
      await terminatePendingOutput();
      await writer.write({
        text: fromSedLocaleText({
          text: output.hadNewline
            ? `${output.text}${recordTerminator}`
            : output.text,
          characterLocaleMode,
        }),
      });
      previousOutputMissingNewline = !output.hadNewline;
    },
    terminatePendingOutput,
    writeAppendText: async ({ text }) => {
      await terminatePendingOutput();
      await writer.write({
        text: fromSedLocaleText({ text: `${text}\n`, characterLocaleMode }),
      });
      previousOutputMissingNewline = false;
    },
    writeReadFile: async ({ lines, terminatePendingOutputWhenEmpty }) => {
      let wroteLine = false;
      if (lines !== undefined) {
        for await (const line of lines) {
          if (!wroteLine && previousOutputMissingNewline) {
            await writer.write({
              text: fromSedLocaleText({ text: recordTerminator, characterLocaleMode }),
            });
          }
          await writer.write({
            text: fromSedLocaleText({
              text: line.hadNewline
                ? `${line.line}${recordTerminator}`
                : line.line,
              characterLocaleMode,
            }),
          });
          wroteLine = true;
        }
      }
      if (
        !wroteLine &&
        terminatePendingOutputWhenEmpty &&
        previousOutputMissingNewline
      ) {
        await writer.write({ text: recordTerminator });
      }
      if (wroteLine || terminatePendingOutputWhenEmpty) {
        previousOutputMissingNewline = false;
      }
    },
    flush: async () => {
      await writer.flush();
    },
  };
}

interface SedWriteFileManager {
  write({ path, output }: { path: string; output: SedOutput }): Promise<void>;
  close(): Promise<void>;
  abort({ reason }: { reason: unknown }): Promise<void>;
}

interface SedTextFileTarget {
  write({ text }: { text: string }): Promise<void>;
  close(): Promise<void>;
  abort({ reason }: { reason: unknown }): Promise<void>;
}

function resolveSedCommandPath({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): string {
  return normalizePath({ cwd: context.cwd, path });
}

function createBufferedEfficientSedWriter({
  writer,
}: {
  writer: WeshEfficientFileWriter;
}): SedTextFileTarget {
  let chunks: string[] = [];
  let bufferedLength = 0;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) return;
    const text = chunks.join("");
    chunks = [];
    bufferedLength = 0;
    await writer.write({ chunk: encodeCommandDataText({ text }) });
  };

  return {
    async write({ text }) {
      if (closed)
        throw new Error("sed: attempted to write to a closed output file");
      chunks.push(text);
      bufferedLength += text.length;
      if (bufferedLength >= 16 * 1024) await flush();
    },
    async close() {
      if (closed) return;
      try {
        await flush();
        await writer.close();
        closed = true;
      } catch (error: unknown) {
        chunks = [];
        bufferedLength = 0;
        try {
          await writer.abort({ reason: error });
        } catch {
          // Preserve the write or close failure.
        }
        closed = true;
        throw error;
      }
    },
    async abort({ reason }) {
      if (closed) return;
      closed = true;
      chunks = [];
      bufferedLength = 0;
      await writer.abort({ reason });
    },
  };
}

async function createSedTextFileTarget({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<SedTextFileTarget> {
  const efficient = await context.files.tryCreateFileWriterEfficiently({
    path,
    mode: "truncate",
  });
  switch (efficient.kind) {
  case "writer":
    return createBufferedEfficientSedWriter({ writer: efficient.writer });
  case "fallback_required":
    break;
  default: {
    const _ex: never = efficient;
    throw new Error(
      `Unhandled sed efficient writer result: ${JSON.stringify(_ex)}`,
    );
  }
  }

  const handle = await context.files.open({
    path,
    flags: {
      access: "write",
      creation: "if-needed",
      truncate: "truncate",
      append: "preserve",
    },
  });
  const writer = createBufferedCommandDataWriter({
    handle,
    maxBufferLength: 16 * 1024,
  });
  let closed = false;
  return {
    write: writer.write,
    async close() {
      if (closed) return;
      let failure: unknown;
      try {
        await writer.flush();
      } catch (error: unknown) {
        failure = error;
      }
      try {
        await handle.close();
      } catch (error: unknown) {
        failure =
          failure === undefined
            ? error
            : new AggregateError(
              [failure, error],
              "sed: failed to flush and close output file",
            );
      }
      closed = true;
      if (failure !== undefined) throw failure;
    },
    async abort() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

async function createSedWriteFileManager({
  context,
  commands,
  recordTerminator,
  characterLocaleMode,
}: {
  context: WeshCommandContext;
  commands: readonly SedCommand[];
  recordTerminator: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): Promise<SedWriteFileManager> {
  const targets = new Map<string, SedTextFileTarget>();
  try {
    for (const command of commands) {
      const path = (() => {
        switch (command.kind) {
        case "writeFile":
        case "writeFileFirst":
          return command.path;
        case "substitute":
          return command.writePath;
        default:
          return undefined;
        }
      })();
      if (path === undefined || targets.has(path)) continue;
      targets.set(
        path,
        await createSedTextFileTarget({
          context,
          path: resolveSedCommandPath({ context, path }),
        }),
      );
    }
  } catch (error: unknown) {
    await Promise.all(
      [...targets.values()].map(async (target) => {
        try {
          await target.abort({ reason: error });
        } catch {
          // Preserve the first output-open error.
        }
      }),
    );
    throw error;
  }

  let closed = false;
  return {
    async write({ path, output }) {
      const target = targets.get(path);
      if (target === undefined)
        throw new Error(`sed: output file was not initialized: ${path}`);
      await target.write({
        text: fromSedLocaleText({
          text: output.hadNewline
            ? `${output.text}${recordTerminator}`
            : output.text,
          characterLocaleMode,
        }),
      });
    },
    async close() {
      if (closed) return;
      const failures: unknown[] = [];
      for (const target of targets.values()) {
        try {
          await target.close();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      closed = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "sed: failed to close output files");
      }
    },
    async abort({ reason }) {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...targets.values()].map(async (target) => {
          try {
            await target.abort({ reason });
          } catch {
            // Preserve the original sed failure.
          }
        }),
      );
    },
  };
}

interface SedReadFileManager {
  write({
    path,
    mode,
    writer,
  }: {
    path: string;
    mode: "all" | "line";
    writer: SedOutputWriter;
  }): Promise<void>;
  close(): Promise<void>;
}

function createSedReadFileManager({
  context,
  delimiterByte,
  characterLocaleMode,
}: {
  context: WeshCommandContext;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): SedReadFileManager {
  const lineIterators = new Map<
    string,
    AsyncIterator<SedTextLine> | undefined
  >();

  const openLines = async ({
    path,
  }: {
    path: string;
  }): Promise<AsyncIterable<SedTextLine> | undefined> => {
    try {
      return readTextRecords({
        stream: await openFileReadStream({
          files: context.files,
          path: resolveSedCommandPath({ context, path }),
        }),
        sourceName: path,
        delimiterByte,
        characterLocaleMode,
      });
    } catch {
      return undefined;
    }
  };

  return {
    async write({ path, mode, writer }) {
      switch (mode) {
      case "all":
        await writer.writeReadFile({
          lines: await openLines({ path }),
          terminatePendingOutputWhenEmpty: true,
        });
        return;
      case "line": {
        if (!lineIterators.has(path)) {
          const lines = await openLines({ path });
          lineIterators.set(path, lines?.[Symbol.asyncIterator]());
        }
        const iterator = lineIterators.get(path);
        const result =
            iterator === undefined ? undefined : await iterator.next();
        const line = result?.done === false ? result.value : undefined;
        await writer.writeReadFile({
          lines:
              line === undefined
                ? undefined
                : (async function* (): AsyncGenerator<SedTextLine> {
                  yield line;
                })(),
          terminatePendingOutputWhenEmpty: false,
        });
        return;
      }
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled sed read-file mode: ${_ex}`);
      }
      }
    },
    async close() {
      const failures: unknown[] = [];
      for (const iterator of lineIterators.values()) {
        try {
          await iterator?.return?.();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      lineIterators.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "sed: failed to close read files");
      }
    },
  };
}

async function processSedLines({
  context,
  lines,
  commands,
  quiet,
  writer,
  writeFiles,
  delimiterByte,
  characterLocaleMode,
}: {
  context: WeshCommandContext;
  lines: AsyncIterable<SedTextLine>;
  commands: SedCommand[];
  quiet: boolean;
  writer: SedOutputWriter;
  writeFiles: SedWriteFileManager;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): Promise<number | undefined> {
  const runtimeCommands = createSedRuntimeCommands({ commands });
  const readFiles = createSedReadFileManager({
    context,
    delimiterByte,
    characterLocaleMode,
  });
  const executionState: SedExecutionState = {
    holdSpace: { text: "", hadNewline: true },
    characterLocaleMode,
  };
  const iterator = lines[Symbol.asyncIterator]();
  let currentResult: IteratorResult<SedTextLine>;
  let lookahead: IteratorResult<SedTextLine> | undefined;
  let lineNumber = 0;

  const ensureLookahead = async (): Promise<IteratorResult<SedTextLine>> => {
    lookahead ??= await iterator.next();
    return lookahead;
  };

  const closeInputs = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await iterator.return?.();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      await readFiles.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "sed: failed to close input streams");
    }
  };

  try {
    currentResult = await iterator.next();
    while (!currentResult.done) {
      lineNumber += 1;
      const current = currentResult.value;
      const result = await executeSedLine({
        runtimeCommands,
        lineNumber,
        current,
        quiet,
        resolveIsLastLine: async () => (await ensureLookahead()).done === true,
        executionState,
        patternSeparator: String.fromCharCode(delimiterByte),
        consumeNextLine: async () => {
          const next = await ensureLookahead();
          if (next.done) return undefined;
          lineNumber += 1;
          const consumed = next.value;
          lookahead = undefined;
          return {
            current: consumed,
            lineNumber,
          };
        },
      });
      for (const action of result.actions) {
        switch (action.kind) {
        case "output":
          await writer.write({ output: action.output });
          break;
        case "terminatePendingOutput":
          await writer.terminatePendingOutput();
          break;
        case "appendText":
          await writer.writeAppendText({ text: action.text });
          break;
        case "readFile":
          await readFiles.write({
            path: action.path,
            mode: action.mode,
            writer,
          });
          break;
        case "writeFile":
          await writeFiles.write({
            path: action.path,
            output: action.output,
          });
          break;
        default: {
          const _ex: never = action;
          throw new Error(`Unhandled sed action: ${JSON.stringify(_ex)}`);
        }
        }
      }
      if (result.quitExitCode !== undefined) {
        await writer.flush();
        await closeInputs();
        return result.quitExitCode;
      }

      if (lookahead !== undefined) {
        currentResult = lookahead;
        lookahead = undefined;
      } else {
        currentResult = await iterator.next();
      }
    }
  } catch (error: unknown) {
    try {
      await closeInputs();
    } catch {
      // Preserve the original sed execution failure.
    }
    throw error;
  }

  await closeInputs();
  await writer.flush();
  return undefined;
}

async function processSedStream({
  context,
  stream,
  sourceName,
  commands,
  quiet,
  writer,
  writeFiles,
  delimiterByte,
  characterLocaleMode,
}: {
  context: WeshCommandContext;
  stream: ReadableStream<Uint8Array>;
  sourceName: string;
  commands: SedCommand[];
  quiet: boolean;
  writer: SedOutputWriter;
  writeFiles: SedWriteFileManager;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): Promise<number | undefined> {
  return await processSedLines({
    context,
    lines: readTextRecords({
      stream,
      sourceName,
      delimiterByte,
      characterLocaleMode,
    }),
    commands,
    quiet,
    writer,
    writeFiles,
    delimiterByte,
    characterLocaleMode,
  });
}

async function* readSedFiles({
  context,
  files,
  resolveFile,
  onError,
  delimiterByte,
  characterLocaleMode,
}: {
  context: WeshCommandContext;
  files: readonly string[];
  resolveFile?: ({ file }: { file: string }) => Promise<string>;
  onError: ({ file, error }: { file: string; error: unknown }) => Promise<boolean>;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): AsyncGenerator<SedTextLine> {
  for (const file of files) {
    try {
      const inputFile = resolveFile === undefined ? file : await resolveFile({ file });
      const stream = await openSedInputStream({ context, file: inputFile });
      yield* readTextRecords({
        stream,
        sourceName: file,
        delimiterByte,
        characterLocaleMode,
      });
    } catch (error: unknown) {
      const shouldContinue = await onError({ file, error });
      if (!shouldContinue) return;
    }
  }
}

async function resolveSedFollowSymlinkPath({
  context,
  file,
  dashIsStdin,
}: {
  context: WeshCommandContext;
  file: string;
  dashIsStdin: boolean;
}): Promise<string> {
  if (dashIsStdin && file === "-") return file;
  const lexicalFullPath = file.startsWith("/") ? file : `${context.cwd}/${file}`;
  return await canonicalizeExistingPath({ context, path: lexicalFullPath });
}

async function createSedTemporaryFile({
  context,
  targetPath,
  mode,
}: {
  context: WeshCommandContext;
  targetPath: string;
  mode: number;
}): Promise<{
  path: string;
  handle: WeshFileHandle;
}> {
  const separatorIndex = targetPath.lastIndexOf("/");
  const parentPath =
    separatorIndex <= 0 ? "/" : targetPath.slice(0, separatorIndex);
  const basename = targetPath.slice(separatorIndex + 1);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = `.${basename}.sed-${context.pid}-${attempt}`;
    const temporaryPath =
      parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    try {
      const handle = await context.files.open({
        path: temporaryPath,
        flags: {
          access: "write",
          creation: "always",
          truncate: "truncate",
          append: "preserve",
        },
        mode,
      });
      return {
        path: temporaryPath,
        handle,
      };
    } catch (error: unknown) {
      if (attempt === 99) {
        throw error;
      }
    }
  }
  throw new Error(`Unable to create temporary file for ${targetPath}`);
}

function createSedRuntimeCommands({
  commands,
}: {
  commands: SedCommand[];
}): SedExecutableRuntimeCommand[] {
  const labelIndices = new Map<string, number>();
  for (const [index, command] of commands.entries()) {
    switch (command.kind) {
    case "label":
      labelIndices.set(command.name, index);
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "quit":
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while collecting runtime labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }

  return commands.map((command) => {
    switch (command.kind) {
    case "substitute":
      return {
        command: {
          kind: "substitute",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          regex: command.regex,
          replacement: command.replacement,
          occurrence: command.occurrence,
          replaceFollowing: command.replaceFollowing,
          print: command.print,
          writePath: command.writePath,
        },
        inRange: false,
        rangeStarted: false,
      };
    case "translate": {
      const sourceCharacters = command.source[Symbol.iterator]();
      const targetCharacters = command.target[Symbol.iterator]();
      const lookup = new Map<string, string>();
      while (true) {
        const sourceCharacter = sourceCharacters.next();
        if (sourceCharacter.done) break;
        const targetCharacter = targetCharacters.next();
        if (
          command.duplicateSourcePrecedence === "last" ||
          !lookup.has(sourceCharacter.value)
        ) {
          lookup.set(
            sourceCharacter.value,
            targetCharacter.done
              ? sourceCharacter.value
              : targetCharacter.value,
          );
        }
      }
      return {
        command: {
          kind: "translate",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          lookup,
        },
        inRange: false,
        rangeStarted: false,
      };
    }
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "quit":
    case "label":
    case "groupEnd":
      return {
        command,
        inRange: false,
        rangeStarted: false,
      };
    case "groupStart":
      return {
        command: {
          kind: "groupStart",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          targetIndex: command.endIndex + 1,
        },
        inRange: false,
        rangeStarted: false,
      };
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
      return {
        command: {
          kind: command.kind,
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          targetIndex:
              command.targetLabel === undefined
                ? undefined
                : labelIndices.get(command.targetLabel),
        },
        inRange: false,
        rangeStarted: false,
      };
    default: {
      const _ex: never = command;
      throw new Error(`Unhandled sed runtime command kind: ${_ex}`);
    }
    }
  });
}

type SedReplacementCaseMode = "none" | "lower" | "upper";

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
    return "ᾼ";
  case 0x1fc3:
    return "ῌ";
  case 0x1ff3:
    return "ῼ";
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
  mode: Exclude<SedReplacementCaseMode, "none">;
  characterLocaleMode: WeshCharacterLocaleMode;
}): string {
  switch (characterLocaleMode) {
  case "ascii": {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit >= 0x80 && codeUnit < 0xff) {
      // GNU sed's C-locale replacement case conversion maps non-ASCII
      // single bytes below 0xff to 0xff for both upper and lower modes.
      return "\xff";
    }
    switch (mode) {
    case "lower":
      return foldAsciiCase({ value: character });
    case "upper":
      return uppercaseAscii({ value: character });
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled replacement case mode: ${_ex}`);
    }
    }
  }
  case "unicode": {
    const converted = (() => {
      switch (mode) {
      case "lower":
        return character.toLowerCase();
      case "upper":
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
    case "lower":
      if (character === "İ") return "i";
      return character;
    case "upper":
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
  let output = "";
  let persistentMode: SedReplacementCaseMode = "none";
  let nextMode: Exclude<SedReplacementCaseMode, "none"> | undefined;

  const append = ({ value }: { value: string }): void => {
    for (const character of value) {
      const mode = nextMode ?? persistentMode;
      nextMode = undefined;
      switch (mode) {
      case "none":
        output += character;
        break;
      case "lower":
      case "upper":
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
    if (character === "&") {
      append({ value: match });
      continue;
    }
    if (character !== "\\") {
      const codePoint = replacement.codePointAt(index);
      const literal = codePoint === undefined ? character : String.fromCodePoint(codePoint);
      append({ value: toSedLocaleText({ text: literal, characterLocaleMode }) });
      if (literal.length === 2) index += 1;
      continue;
    }

    const next = replacement[index + 1];
    if (next === undefined) {
      append({ value: "\\" });
      continue;
    }
    if (next === "0") {
      append({ value: match });
      index += 1;
      continue;
    }
    if (/^[1-9]$/.test(next)) {
      append({ value: captures[Number.parseInt(next, 10) - 1] ?? "" });
      index += 1;
      continue;
    }
    if (next === "&" || next === "\\") {
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
    if (next === "c") {
      // GNU sed preserves the backslash for an incomplete replacement \c.
      append({ value: "\\" });
      index += 1;
      continue;
    }
    switch (next) {
    case "L":
      persistentMode = "lower";
      nextMode = undefined;
      break;
    case "U":
      persistentMode = "upper";
      nextMode = undefined;
      break;
    case "E":
      persistentMode = "none";
      nextMode = undefined;
      break;
    case "l":
      nextMode = "lower";
      break;
    case "u":
      nextMode = "upper";
      break;
    default:
      append({ value: next });
      break;
    }
    index += 1;
  }
  return output;
}

function substituteSedPattern({
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
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  );
  const interiorByteEmptyMatch = (() => {
    if (characterLocaleMode !== "unicode" || regex.source.includes("\\p{")) return undefined;
    const result = findPosixLeftmostLongestMatch({
      regex: searchRegex,
      source: "!!",
      startIndex: 1,
    });
    return result?.index === 1 && result.text.length === 0 ? result : undefined;
  })();
  let cursor = 0;
  let searchIndex = 0;
  let previousNonEmptyMatchEnd = -1;
  let text = "";
  let matchNumber = 0;
  let replacedAny = false;

  const appendReplacement = ({ captures }: { captures: readonly (string | undefined)[] }): boolean => {
    matchNumber += 1;
    const shouldReplace =
      matchNumber === occurrence ||
      (replaceFollowing && matchNumber > occurrence);
    if (!shouldReplace) return false;
    text += applySedReplacement({
      replacement,
      match: "",
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
      matchNumber === occurrence ||
      (replaceFollowing && matchNumber > occurrence);
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

async function executeSedLine({
  runtimeCommands,
  lineNumber: initialLineNumber,
  current,
  quiet,
  resolveIsLastLine,
  executionState,
  consumeNextLine,
  patternSeparator,
}: {
  runtimeCommands: SedExecutableRuntimeCommand[];
  lineNumber: number;
  current: SedTextLine;
  quiet: boolean;
  resolveIsLastLine: () => Promise<boolean>;
  executionState: SedExecutionState;
  consumeNextLine: () => Promise<
    | {
        current: SedTextLine;
        lineNumber: number;
      }
    | undefined
  >;
  patternSeparator: string;
}): Promise<SedLineResult> {
  let lineNumber = initialLineNumber;
  let isLastLine: boolean | undefined;
  let patternSpace: SedSpace = {
    text: current.line,
    hadNewline: current.hadNewline,
  };
  let sourceName = current.sourceName;
  let deleted = false;
  let quitExitCode: number | undefined;
  const actions: SedAction[] = [];
  const pendingAppends: SedAction[] = [];
  let substitutionSucceeded = false;

  const flushPendingAppends = (): void => {
    for (const pendingAppend of pendingAppends) actions.push(pendingAppend);
    pendingAppends.length = 0;
  };
  let commandIndex = 0;
  let executionSteps = 0;

  const getIsLastLine = async (): Promise<boolean> => {
    isLastLine ??= await resolveIsLastLine();
    return isLastLine;
  };

  const settleRanges = ({
    startIndex,
    endIndex,
    line,
    reason,
  }: {
    startIndex: number;
    endIndex: number;
    line: string;
    reason: "cycleTermination" | "inputConsumption";
  }): void => {
    settleActiveRangeEnds({
      runtimeCommands,
      startIndex,
      endIndex,
      lineNumber,
      line,
      reason,
    });
  };

  while (commandIndex < runtimeCommands.length) {
    executionSteps += 1;
    if (executionSteps > 100_000) {
      throw new Error("sed: command execution limit exceeded");
    }
    const runtimeCommand = runtimeCommands[commandIndex]!;
    let nextCommandIndex = commandIndex + 1;
    const needsLastLine = commandNeedsLastLine({
      runtimeCommand,
      lineNumber,
      line: patternSpace.text,
    });
    if (
      !commandApplies({
        runtimeCommand,
        lineNumber,
        line: patternSpace.text,
        isLastLine: needsLastLine ? await getIsLastLine() : false,
      })
    ) {
      commandIndex = (() => {
        switch (runtimeCommand.command.kind) {
        case "groupStart":
          return runtimeCommand.command.targetIndex;
        case "substitute":
        case "translate":
        case "append":
        case "insert":
        case "change":
        case "print":
        case "printFirst":
        case "list":
        case "lineNumber":
        case "hold":
        case "holdAppend":
        case "get":
        case "getAppend":
        case "exchange":
        case "delete":
        case "deleteFirst":
        case "next":
        case "nextAppend":
        case "readFile":
        case "readFileLine":
        case "writeFile":
        case "writeFileFirst":
        case "clear":
        case "fileName":
        case "quit":
        case "label":
        case "branch":
        case "branchIfSubstituted":
        case "branchIfNotSubstituted":
        case "groupEnd":
          return nextCommandIndex;
        default: {
          const _ex: never = runtimeCommand.command;
          throw new Error(
            `Unhandled sed runtime command: ${JSON.stringify(_ex)}`,
          );
        }
        }
      })();
      continue;
    }

    switch (runtimeCommand.command.kind) {
    case "substitute": {
      const substitution = substituteSedPattern({
        source: patternSpace.text,
        regex: runtimeCommand.command.regex,
        replacement: runtimeCommand.command.replacement,
        occurrence: runtimeCommand.command.occurrence,
        replaceFollowing: runtimeCommand.command.replaceFollowing,
        characterLocaleMode: executionState.characterLocaleMode,
      });
      patternSpace.text = substitution.text;
      substitutionSucceeded ||= substitution.matched;
      if (substitution.matched && runtimeCommand.command.print) {
        actions.push({ kind: "output", output: { ...patternSpace } });
      }
      if (
        substitution.matched &&
          runtimeCommand.command.writePath !== undefined
      ) {
        actions.push({
          kind: "writeFile",
          path: runtimeCommand.command.writePath,
          output: { ...patternSpace },
        });
      }
      break;
    }
    case "translate": {
      const command = runtimeCommand.command;
      let translated = "";
      for (const character of patternSpace.text) {
        translated += command.lookup.get(character) ?? character;
      }
      patternSpace.text = translated;
      break;
    }
    case "append":
      if (runtimeCommand.command.text !== undefined) {
        pendingAppends.push({
          kind: "appendText",
          text: runtimeCommand.command.text,
        });
      }
      break;
    case "insert":
      if (runtimeCommand.command.text !== undefined) {
        actions.push({
          kind: "output",
          output: { text: runtimeCommand.command.text, hadNewline: true },
        });
      }
      break;
    case "change":
      if (
        runtimeCommand.command.text !== undefined &&
          (runtimeCommand.command.rangeEnd === undefined ||
            !runtimeCommand.inRange)
      ) {
        actions.push({
          kind: "output",
          output: { text: runtimeCommand.command.text, hadNewline: true },
        });
      }
      deleted = true;
      break;
    case "print":
      actions.push({ kind: "output", output: { ...patternSpace } });
      break;
    case "printFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      actions.push({
        kind: "output",
        output:
            newlineIndex < 0
              ? { ...patternSpace }
              : {
                text: patternSpace.text.slice(0, newlineIndex),
                hadNewline: true,
              },
      });
      break;
    }
    case "list":
      actions.push({
        kind: "output",
        output: {
          text: renderSedList({
            text: patternSpace.text,
            width: runtimeCommand.command.width,
            continuationSeparator: patternSeparator,
            characterLocaleMode: executionState.characterLocaleMode,
          }),
          hadNewline: true,
        },
      });
      break;
    case "lineNumber":
      actions.push({
        kind: "output",
        output: { text: String(lineNumber), hadNewline: true },
      });
      break;
    case "hold":
      executionState.holdSpace = { ...patternSpace };
      break;
    case "holdAppend":
      executionState.holdSpace = {
        text: `${executionState.holdSpace.text}${patternSeparator}${patternSpace.text}`,
        hadNewline: patternSpace.hadNewline,
      };
      break;
    case "get":
      patternSpace = { ...executionState.holdSpace };
      break;
    case "getAppend":
      patternSpace = {
        text: `${patternSpace.text}${patternSeparator}${executionState.holdSpace.text}`,
        hadNewline: executionState.holdSpace.hadNewline,
      };
      break;
    case "exchange": {
      const previousPatternSpace = patternSpace;
      patternSpace = executionState.holdSpace;
      executionState.holdSpace = previousPatternSpace;
      break;
    }
    case "delete":
      deleted = true;
      break;
    case "deleteFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      if (newlineIndex < 0) {
        deleted = true;
        break;
      }
      patternSpace = {
        text: patternSpace.text.slice(newlineIndex + 1),
        hadNewline: patternSpace.hadNewline,
      };
      flushPendingAppends();
      substitutionSucceeded = false;
      commandIndex = 0;
      continue;
    }
    case "next": {
      if (!quiet)
        actions.push({ kind: "output", output: { ...patternSpace } });
      flushPendingAppends();
      const next = await consumeNextLine();
      if (next === undefined) {
        deleted = true;
        break;
      }
      patternSpace = {
        text: next.current.line,
        hadNewline: next.current.hadNewline,
      };
      sourceName = next.current.sourceName;
      lineNumber = next.lineNumber;
      isLastLine = undefined;
      settleRanges({
        startIndex: 0,
        endIndex: runtimeCommands.length,
        line: next.current.line,
        reason: "inputConsumption",
      });
      substitutionSucceeded = false;
      break;
    }
    case "nextAppend": {
      const next = await consumeNextLine();
      if (next === undefined) {
        commandIndex = runtimeCommands.length;
        continue;
      }
      patternSpace = {
        text: `${patternSpace.text}${patternSeparator}${next.current.line}`,
        hadNewline: next.current.hadNewline,
      };
      sourceName = next.current.sourceName;
      lineNumber = next.lineNumber;
      isLastLine = undefined;
      settleRanges({
        startIndex: 0,
        endIndex: runtimeCommands.length,
        line: next.current.line,
        reason: "inputConsumption",
      });
      substitutionSucceeded = false;
      break;
    }
    case "readFile":
      pendingAppends.push({
        kind: "readFile",
        path: runtimeCommand.command.path,
        mode: "all",
      });
      break;
    case "readFileLine":
      pendingAppends.push({
        kind: "readFile",
        path: runtimeCommand.command.path,
        mode: "line",
      });
      break;
    case "writeFile":
      actions.push({
        kind: "writeFile",
        path: runtimeCommand.command.path,
        output: { ...patternSpace },
      });
      break;
    case "writeFileFirst": {
      const newlineIndex = patternSpace.text.indexOf(patternSeparator);
      actions.push({
        kind: "writeFile",
        path: runtimeCommand.command.path,
        output:
            newlineIndex < 0
              ? { ...patternSpace }
              : {
                text: patternSpace.text.slice(0, newlineIndex),
                hadNewline: true,
              },
      });
      break;
    }
    case "clear":
      patternSpace = { text: "", hadNewline: patternSpace.hadNewline };
      break;
    case "fileName":
      actions.push({
        kind: "output",
        output: { text: sourceName, hadNewline: true },
      });
      break;
    case "quit":
      quitExitCode = runtimeCommand.command.exitCode;
      if (runtimeCommand.command.printPattern) {
        actions.push({ kind: "terminatePendingOutput" });
        patternSpace.hadNewline = true;
      } else {
        deleted = true;
      }
      break;
    case "label":
    case "groupStart":
    case "groupEnd":
      break;
    case "branch":
      nextCommandIndex =
          runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      break;
    case "branchIfSubstituted": {
      const shouldBranch = substitutionSucceeded;
      substitutionSucceeded = false;
      if (shouldBranch) {
        nextCommandIndex =
            runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      }
      break;
    }
    case "branchIfNotSubstituted": {
      const shouldBranch = !substitutionSucceeded;
      substitutionSucceeded = false;
      if (shouldBranch) {
        nextCommandIndex =
            runtimeCommand.command.targetIndex ?? runtimeCommands.length;
      }
      break;
    }
    default: {
      const _ex: never = runtimeCommand.command;
      throw new Error(`Unhandled sed command kind: ${_ex}`);
    }
    }

    if (quitExitCode !== undefined) break;
    if (deleted) {
      settleRanges({
        startIndex: commandIndex + 1,
        endIndex: runtimeCommands.length,
        line: patternSpace.text,
        reason: "cycleTermination",
      });
      break;
    }
    commandIndex = nextCommandIndex;
  }

  if (!deleted && !quiet) {
    actions.push({ kind: "output", output: patternSpace });
  }
  flushPendingAppends();

  return {
    actions,
    quitExitCode,
  };
}

export const sedCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: "sed",
    description: "Stream editor for filtering and transforming text",
    usage: "sed [OPTION]... {script-only-if-no-other-script} [input-file]...",
  },
  fn: async ({
    context,
  }: {
    context: WeshCommandContext;
  }): Promise<WeshCommandResult> => {
    const sedArgvSpec: StandardArgvParserSpec = {
      options: [
        {
          kind: "flag",
          short: "n",
          long: "quiet",
          effects: [{ key: "quiet", value: true }],
          help: {
            summary: "suppress automatic printing of pattern space",
            category: "common",
          },
        },
        {
          kind: "flag",
          short: undefined,
          long: "silent",
          effects: [{ key: "quiet", value: true }],
          help: {
            summary: "suppress automatic printing of pattern space",
            category: "common",
          },
        },
        {
          kind: "value",
          short: "e",
          long: "expression",
          key: "expression",
          valueName: "script",
          allowAttachedValue: true,
          parseValue: undefined,
          help: {
            summary: "add a script to the commands to be executed",
            category: "common",
          },
        },
        {
          kind: "value",
          short: "f",
          long: "file",
          key: "scriptFile",
          valueName: "script-file",
          allowAttachedValue: true,
          parseValue: undefined,
          help: {
            summary: "add a script file to the commands to be executed",
            category: "common",
          },
        },
        {
          kind: "flag",
          short: "r",
          long: undefined,
          effects: [{ key: "extendedRegexp", value: true }],
          help: {
            summary: "use extended regular expressions",
            category: "common",
          },
        },
        {
          kind: "flag",
          short: "E",
          long: "regexp-extended",
          effects: [{ key: "extendedRegexp", value: true }],
          help: {
            summary: "use extended regular expressions",
            category: "common",
          },
        },
        {
          kind: "flag",
          short: "z",
          long: "null-data",
          effects: [{ key: "nullData", value: true }],
          help: {
            summary: "separate records by NUL characters",
            category: "advanced",
          },
        },
        {
          kind: "flag",
          short: "u",
          long: "unbuffered",
          effects: [{ key: "unbuffered", value: true }],
          help: {
            summary: "flush output more frequently",
            category: "advanced",
          },
        },
        {
          kind: "flag",
          short: "s",
          long: "separate",
          effects: [{ key: "separate", value: true }],
          help: {
            summary: "treat input files as separate streams",
            category: "advanced",
          },
        },
        {
          kind: "value",
          short: "l",
          long: "line-length",
          key: "lineLength",
          valueName: "N",
          allowAttachedValue: true,
          parseValue: undefined,
          help: {
            summary: "specify the desired line-wrap length for the l command",
            category: "advanced",
          },
        },
        {
          kind: "value",
          short: "i",
          long: "in-place",
          key: "inPlaceSuffix",
          valueName: "suffix",
          allowAttachedValue: true,
          parseValue: undefined,
          help: {
            summary: "edit files in place, optionally keeping a backup suffix",
            category: "advanced",
          },
        },
        {
          kind: "flag",
          short: undefined,
          long: "follow-symlinks",
          effects: [{ key: "followSymlinks", value: true }],
          help: {
            summary: "follow symbolic links when processing in place",
            category: "advanced",
          },
        },
        {
          kind: "flag",
          short: undefined,
          long: "help",
          effects: [{ key: "help", value: true }],
          help: { summary: "display this help and exit", category: "common" },
        },
      ],
      allowShortFlagBundles: true,
      stopAtDoubleDash: true,
      treatSingleDashAsPositional: true,
      specialTokenParsers: [],
    };

    const normalizedArgs = normalizeSedOptionalInPlaceArguments({
      args: context.args,
    });
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: normalizedArgs,
        spec: sedArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: sedArgvSpec,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: "sed",
        message: `sed: ${parsed.diagnostics[0]!.message}`,
        argvSpec: sedArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: "sed",
        argvSpec: sedArgvSpec,
      });
      return { exitCode: 0 };
    }

    const scripts: string[] = [];
    for (const occurrence of parsed.occurrences) {
      if (occurrence.kind !== "value" || typeof occurrence.value !== "string")
        continue;
      if (occurrence.key === "expression") {
        scripts.push(occurrence.value);
        continue;
      }
      if (occurrence.key !== "scriptFile") continue;
      const scriptFile = occurrence.value;
      try {
        const bytes = scriptFile === "-"
          ? await readAllHandleBytes({ handle: context.stdin })
          : await (async (): Promise<Uint8Array> => {
            const path = resolveSedCommandPath({ context, path: scriptFile });
            const stat = await context.files.stat({ path });
            switch (stat.type) {
            case "directory":
              return new Uint8Array();
            case "file":
            case "symlink":
            case "fifo":
            case "chardev":
              return await readAllFileBytes({ files: context.files, path });
            default: {
              const _ex: never = stat.type;
              throw new Error(`Unhandled sed script source type: ${_ex}`);
            }
            }
          })();
        scripts.push(decodeCommandDataBytes({ bytes }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context
          .text()
          .error({ text: `sed: ${scriptFile}: ${message}\n` });
        return { exitCode: 4 };
      }
    }

    const files = [...parsed.positionals];
    if (scripts.length === 0) {
      const expression = files.shift();
      if (expression === undefined) {
        await writeCommandUsageError({
          context,
          command: "sed",
          message: "sed: missing expression",
          argvSpec: sedArgvSpec,
        });
        return { exitCode: 1 };
      }
      scripts.push(expression);
    }

    const joinedScript = scripts.join("\n");
    const sourceBoundaryIndices = new Set<number>();
    let sourceOffset = 0;
    for (let sourceIndex = 0; sourceIndex < scripts.length - 1; sourceIndex += 1) {
      sourceOffset += scripts[sourceIndex]!.length;
      sourceBoundaryIndices.add(sourceOffset);
      sourceOffset += 1;
    }

    const nullData = parsed.optionValues.nullData === true;
    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const parseState: SedParseState = {
      syntax:
        parsed.optionValues.extendedRegexp === true ? "extended" : "basic",
      characterLocaleMode,
      nullData,
      sourceBoundaryIndices,
      previousRegex: undefined,
      previousCaptureCount: 0,
    };
    const parsedScript = parseSedScript({
      script: joinedScript,
      state: parseState,
    });
    if (!parsedScript.ok) {
      await writeCommandUsageError({
        context,
        command: "sed",
        message: `sed: ${parsedScript.message}`,
        argvSpec: sedArgvSpec,
      });
      return { exitCode: 1 };
    }
    const lineLengthValue = parsed.optionValues.lineLength;
    const defaultListWidth =
      typeof lineLengthValue === "string"
        ? parseSedLineLengthOption({ value: lineLengthValue })
        : undefined;
    const allCommands = parsedScript.commands.map((command): SedCommand =>
      command.kind === "list" &&
      command.width === undefined &&
      defaultListWidth !== undefined
        ? { ...command, width: defaultListWidth }
        : command,
    );
    const labelValidation = validateSedLabels({ commands: allCommands });
    if (!labelValidation.ok) {
      await context.text().error({
        text: `sed: ${labelValidation.message}
`,
      });
      return { exitCode: 4 };
    }

    const quiet =
      parsed.optionValues.quiet === true ||
      scripts[0]?.startsWith("#n") === true;
    const inPlace = parsed.optionValues.inPlaceSuffix !== undefined;
    const followSymlinks = parsed.optionValues.followSymlinks === true;
    const separate = parsed.optionValues.separate === true;
    const rawInPlaceSuffix =
      typeof parsed.optionValues.inPlaceSuffix === "string"
        ? parsed.optionValues.inPlaceSuffix
        : "";
    const inPlaceSuffix =
      rawInPlaceSuffix === SED_EMPTY_IN_PLACE_SUFFIX_SENTINEL
        ? ""
        : rawInPlaceSuffix;
    const delimiterByte = nullData ? 0x00 : 0x0a;
    const recordTerminator = nullData ? "\0" : "\n";
    const bufferedStdout = createBufferedCommandDataWriter({
      handle: context.stdout,
      maxBufferLength: 16384,
    });
    const stdoutWriter = createSedOutputWriter({
      writer: bufferedStdout,
      recordTerminator,
      characterLocaleMode,
    });

    if (files.length === 0) {
      if (inPlace) {
        await context.text().error({ text: "sed: no input files\n" });
        return { exitCode: 4 };
      }
    }

    let writeFiles: SedWriteFileManager;
    try {
      writeFiles = await createSedWriteFileManager({
        context,
        commands: allCommands,
        recordTerminator,
        characterLocaleMode,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `sed: ${message}\n` });
      return { exitCode: 4 };
    }

    const finish = async ({
      exitCode,
    }: {
      exitCode: number;
    }): Promise<WeshCommandResult> => {
      await writeFiles.close();
      return { exitCode };
    };

    try {
      if (files.length === 0) {
        const quitExitCode = await processSedStream({
          context,
          stream: openHandleReadStream({ handle: context.stdin }),
          sourceName: "-",
          commands: allCommands,
          quiet,
          writer: stdoutWriter,
          writeFiles,
          delimiterByte,
          characterLocaleMode,
        });
        return await finish({ exitCode: quitExitCode ?? 0 });
      }

      let exitCode = 0;
      if (!inPlace && !separate) {
        const quitExitCode = await processSedLines({
          context,
          lines: readSedFiles({
            context,
            files,
            delimiterByte,
            characterLocaleMode,
            resolveFile: followSymlinks
              ? async ({ file }) =>
                await resolveSedFollowSymlinkPath({
                  context,
                  file,
                  dashIsStdin: true,
                })
              : undefined,
            onError: async ({ file, error }) => {
              exitCode = followSymlinks ? 4 : 2;
              const message =
                error instanceof Error ? error.message : String(error);
              await context.text().error({
                text: followSymlinks
                  ? `sed: couldn't follow symlink ${file}: ${message}\n`
                  : `sed: ${file}: ${message}\n`,
              });
              return !followSymlinks;
            },
          }),
          commands: allCommands,
          quiet,
          writer: stdoutWriter,
          writeFiles,
          delimiterByte,
          characterLocaleMode,
        });
        return await finish({
          exitCode: exitCode !== 0 ? exitCode : (quitExitCode ?? 0),
        });
      }

      if (!inPlace) {
        for (const file of files) {
          try {
            const inputFile = followSymlinks
              ? await resolveSedFollowSymlinkPath({
                context,
                file,
                dashIsStdin: true,
              })
              : file;
            const quitExitCode = await processSedStream({
              context,
              stream: await openSedInputStream({ context, file: inputFile }),
              sourceName: file,
              commands: allCommands,
              quiet,
              writer: stdoutWriter,
              writeFiles,
              delimiterByte,
              characterLocaleMode,
            });
            if (quitExitCode !== undefined) {
              if (exitCode === 0) exitCode = quitExitCode;
              break;
            }
          } catch (error: unknown) {
            exitCode = followSymlinks ? 4 : 2;
            const message =
              error instanceof Error ? error.message : String(error);
            await context.text().error({
              text: followSymlinks
                ? `sed: couldn't follow symlink ${file}: ${message}\n`
                : `sed: ${file}: ${message}\n`,
            });
            if (followSymlinks) break;
          }
        }
        await bufferedStdout.flush();
        return await finish({ exitCode });
      }

      for (const file of files) {
        if (file === undefined) continue;

        try {
          const lexicalFullPath = file.startsWith("/")
            ? file
            : `${context.cwd}/${file}`;
          let fullPath = lexicalFullPath;
          if (followSymlinks) {
            try {
              fullPath = await resolveSedFollowSymlinkPath({
                context,
                file,
                dashIsStdin: false,
              });
            } catch (error: unknown) {
              exitCode = 4;
              const message =
                error instanceof Error ? error.message : String(error);
              await context.text().error({
                text: `sed: couldn't follow symlink ${file}: ${message}\n`,
              });
              break;
            }
          }

          const originalStat = await context.files.stat({ path: fullPath });
          switch (originalStat.type) {
          case "file":
            break;
          case "directory":
          case "fifo":
          case "chardev":
          case "symlink":
            exitCode = 4;
            await context.text().error({
              text: `sed: couldn't edit ${file}: not a regular file
`,
            });
            break;
          default: {
            const _ex: never = originalStat.type;
            throw new Error(`Unhandled sed in-place input type: ${_ex}`);
          }
          }
          if (exitCode === 4) break;

          let temporary: Awaited<ReturnType<typeof createSedTemporaryFile>>;
          try {
            temporary = await createSedTemporaryFile({
              context,
              targetPath: fullPath,
              mode: originalStat.mode,
            });
          } catch (error: unknown) {
            exitCode = 4;
            const message = error instanceof Error ? error.message : String(error);
            await context.text().error({
              text: `sed: couldn't edit ${file}: ${message}
`,
            });
            break;
          }
          let temporaryExists = true;
          try {
            const temporaryWriter = createBufferedCommandDataWriter({
              handle: temporary.handle,
              maxBufferLength: 16 * 1024,
            });
            const sedTemporaryWriter = createSedOutputWriter({
              writer: temporaryWriter,
              recordTerminator,
              characterLocaleMode,
            });
            const quitExitCode = await processSedStream({
              context,
              stream: await openSedInputStream({
                context,
                file: followSymlinks ? fullPath : file,
              }),
              sourceName: file,
              commands: allCommands,
              quiet,
              writer: sedTemporaryWriter,
              writeFiles,
              delimiterByte,
              characterLocaleMode,
            });
            await temporary.handle.close();

            const recoveryPath =
              inPlaceSuffix.length > 0
                ? resolveSedInPlaceRecoveryPath({
                  cwd: context.cwd,
                  file: followSymlinks ? fullPath : file,
                  fullPath,
                  suffix: inPlaceSuffix,
                })
                : `${temporary.path}.original`;
            let originalMoved = false;
            try {
              await context.files.rename({
                oldPath: fullPath,
                newPath: recoveryPath,
              });
              originalMoved = true;
              try {
                await context.files.rename({
                  oldPath: temporary.path,
                  newPath: fullPath,
                });
                temporaryExists = false;
              } catch (replaceError: unknown) {
                try {
                  await context.files.rename({
                    oldPath: recoveryPath,
                    newPath: fullPath,
                  });
                  originalMoved = false;
                } catch (restoreError: unknown) {
                  throw new AggregateError(
                    [replaceError, restoreError],
                    `sed: failed to replace and restore ${fullPath}`,
                  );
                }
                throw replaceError;
              }

              if (inPlaceSuffix.length === 0) {
                await context.files.unlink({ path: recoveryPath });
                originalMoved = false;
              }

              if (quitExitCode !== undefined) {
                if (exitCode === 0) exitCode = quitExitCode;
                break;
              }
            } catch (error: unknown) {
              if (originalMoved && inPlaceSuffix.length === 0) {
                try {
                  await context.files.rename({
                    oldPath: recoveryPath,
                    newPath: fullPath,
                  });
                } catch {
                  // Preserve the original replacement error.
                }
              }
              exitCode = 4;
              const message = error instanceof Error ? error.message : String(error);
              await context.text().error({
                text: `sed: cannot rename ${file}: ${message}
`,
              });
              break;
            }
          } finally {
            await temporary.handle.close();
            if (temporaryExists) {
              try {
                await context.files.unlink({ path: temporary.path });
              } catch {
                // Preserve the original sed error when temporary cleanup fails.
              }
            }
          }
        } catch (error: unknown) {
          exitCode = 2;
          const message =
            error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `sed: ${file}: ${message}\n` });
        }
      }

      await bufferedStdout.flush();

      return await finish({ exitCode });
    } catch (error: unknown) {
      await writeFiles.abort({ reason: error });
      throw error;
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
