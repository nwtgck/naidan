import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { getPathErrorReason } from '@/features/wesh/commands/_shared/path-errors';
import type {
  WeshCommandImplementation,
  WeshCommandResult,
  WeshCommandContext,
  WeshEntryRef,
  WeshFileHandle,
} from "@/features/wesh/types";
import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvOccurrence,
  type StandardArgvPolicy,
} from "@/features/wesh/argv";
import { decodeCommandDataBytes, encodeCommandDataText } from "@/features/wesh/commands/_shared/data-codec";
import {
  foldAsciiCase,
  resolveCharacterLocaleMode,
  type WeshCharacterLocaleMode,
} from "@/features/wesh/commands/_shared/locale";
import {
  writeCommandHelp,
  writeCommandUsageError,
} from "@/features/wesh/commands/_shared/usage-output";
import {
  findPosixLeftmostLongestMatch,
  translateBasicRegularExpression,
  translateExtendedRegularExpression,
  translatePosixCharacterClasses,
} from "@/features/wesh/commands/_shared/posix-regexp";
import {
  openFileReadStream,
  openHandleReadStream,
  readAllFileBytes,
  writeAllBytesToHandle,
} from "@/features/wesh/utils/fs";
import { iterateUtf8RecordEntries } from "@/features/wesh/utils/text-records";
import { hasPotentiallyUnsafeBacktrackingStructure } from "@/features/wesh/commands/_shared/backtracking-safety";
import {
  beginGrepColor,
  colorizeGrepText,
  endGrepColor,
  resolveGrepColorPalette,
  resolveGrepLineColorCapability,
  type GrepColorCapability,
  type GrepColorMode,
} from "@/features/wesh/commands/grep/color";

interface GrepFileReport {
  matched: boolean;
  selectedLineCount: number;
}

interface GrepFileSelectionRule {
  include: boolean;
  pattern: RegExp;
}

type GrepOutputMode =
  | "lines"
  | "count"
  | "files-with-matches"
  | "files-without-match"
  | "only-matching";
type GrepPatternSyntax = "basic" | "extended" | "perl" | "fixed";
type GrepBinaryFilesMode = "binary" | "text" | "without-match";
type GrepRecursiveMode = "command-line" | "logical";
type GrepDirectoryAction = "read" | "recurse" | "skip";
type GrepDeviceAction = "read" | "skip";

const GREP_BINARY_DETECTION_BYTE_LIMIT = 32 * 1024;
const GREP_NON_SEEKABLE_OFFSET_WIDTH = 19;
const GREP_UNSAFE_BACKTRACKING_RECORD_LIMIT = 24;
const GREP_TEXT_ENCODER = new TextEncoder();

type GrepOutputChunk = string | Uint8Array;

function createBufferedGrepWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle;
  maxBufferLength: number;
}) {
  let chunks: GrepOutputChunk[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const encodedChunks = chunks.map((chunk) =>
      typeof chunk === "string" ? GREP_TEXT_ENCODER.encode(chunk) : chunk,
    );
    const byteLength = encodedChunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    chunks = [];
    bufferedLength = 0;

    if (encodedChunks.length === 1) {
      await writeAllBytesToHandle({ handle, data: encodedChunks[0]! });
      return;
    }

    const data = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of encodedChunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await writeAllBytesToHandle({ handle, data });
  };

  const flushIfNeeded = async (): Promise<void> => {
    if (bufferedLength >= maxBufferLength) {
      await flush();
    }
  };

  return {
    async write({ text }: { text: string }): Promise<void> {
      if (text.length === 0) {
        return;
      }
      chunks.push(text);
      bufferedLength += text.length;
      await flushIfNeeded();
    },
    async writeChunks({
      values,
    }: {
      values: readonly GrepOutputChunk[];
    }): Promise<void> {
      for (const value of values) {
        const length =
          typeof value === "string" ? value.length : value.byteLength;
        if (length === 0) {
          continue;
        }
        chunks.push(value);
        bufferedLength += length;
      }
      await flushIfNeeded();
    },
    flush,
  };
}

function createUtf8ByteOffsetTracker({
  text,
  baseByteOffset,
}: {
  text: string;
  baseByteOffset: number;
}): {
  getByteOffset({ codeUnitIndex }: { codeUnitIndex: number }): number;
} {
  let measuredCodeUnitIndex = 0;
  let measuredByteOffset = baseByteOffset;

  return {
    getByteOffset({ codeUnitIndex }: { codeUnitIndex: number }): number {
      if (codeUnitIndex < measuredCodeUnitIndex) {
        throw new Error("grep match offsets must be nondecreasing");
      }
      measuredByteOffset += encodeCommandDataText({
        text: text.slice(measuredCodeUnitIndex, codeUnitIndex),
      }).byteLength;
      measuredCodeUnitIndex = codeUnitIndex;
      return measuredByteOffset;
    },
  };
}

function parseBinaryFilesMode({
  value,
}: {
  value: string;
}): { ok: true; value: GrepBinaryFilesMode } | { ok: false; message: string } {
  switch (value) {
  case "binary":
  case "text":
  case "without-match":
    return { ok: true, value };
  default:
    return { ok: false, message: `unknown binary-files type '${value}'` };
  }
}

function parseDeviceAction({
  value,
}: {
  value: string;
}): { ok: true; value: GrepDeviceAction } | { ok: false; message: string } {
  switch (value) {
  case "read":
  case "skip":
    return { ok: true, value };
  default:
    return { ok: false, message: `unknown devices action '${value}'` };
  }
}

function parseDirectoryAction({
  value,
}: {
  value: string;
}): { ok: true; value: GrepDirectoryAction } | { ok: false; message: string } {
  switch (value) {
  case "read":
  case "recurse":
  case "skip":
    return { ok: true, value };
  default:
    return { ok: false, message: `unknown directories action '${value}'` };
  }
}

function parseColorMode({
  value,
}: {
  value: string;
}): { ok: true; value: GrepColorMode } | { ok: false; message: string } {
  switch (value) {
  case "never":
  case "none":
  case "auto":
    // Wesh command handles are not terminal-aware. GNU grep's auto mode therefore
    // has the same observable output as never for this execution environment.
    return { ok: true, value: "never" };
  case "always":
    return { ok: true, value };
  default:
    return { ok: false, message: `unknown color mode '${value}'` };
  }
}

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith("/")) {
    return path;
  }

  return cwd === "/" ? `/${path}` : `${cwd}/${path}`;
}

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef;
}): WeshEntryRef<"directory"> {
  switch (entry.type) {
  case "directory":
    return entry as WeshEntryRef<"directory">;
  case "file":
  case "fifo":
  case "chardev":
  case "symlink":
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
}

function basename({ path }: { path: string }): string {
  if (path === "/") {
    return "/";
  }
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  const separatorIndex = path.lastIndexOf("/", end - 1);
  return path.slice(separatorIndex + 1, end);
}

function escapeRegExp({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function foldAsciiRegularExpressionSource({
  source,
}: {
  source: string;
}): string {
  let result = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const next = source[index + 1];
      result += character;
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    result +=
      character >= "A" && character <= "Z"
        ? character.toLowerCase()
        : character;
  }

  return result;
}

function consumeGlobCharacterClass({
  pattern,
  startIndex,
}: {
  pattern: string;
  startIndex: number;
}): { source: string; endIndex: number } | undefined {
  let index = startIndex + 1;
  if (pattern[index] === "!" || pattern[index] === "^") {
    index += 1;
  }
  if (pattern[index] === "]") {
    index += 1;
  }

  while (index < pattern.length) {
    const marker = pattern[index + 1];
    if (
      pattern[index] === "[" &&
      (marker === ":" || marker === "." || marker === "=")
    ) {
      const closing = `${marker}]`;
      const subexpressionEnd = pattern.indexOf(closing, index + 2);
      if (subexpressionEnd >= 0) {
        index = subexpressionEnd + 2;
        continue;
      }
    }
    if (pattern[index] === "\\" && index + 1 < pattern.length) {
      index += 2;
      continue;
    }
    if (pattern[index] === "]") {
      const raw = pattern.slice(startIndex, index + 1);
      return {
        source: raw.startsWith("[!") ? `[^${raw.slice(2)}` : raw,
        endIndex: index,
      };
    }
    index += 1;
  }

  return undefined;
}

function globToRegExp({
  pattern,
  characterLocaleMode,
}: {
  pattern: string;
  characterLocaleMode: WeshCharacterLocaleMode;
}): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) {
      continue;
    }

    switch (char) {
    case "*":
      source += ".*";
      break;
    case "?":
      source += ".";
      break;
    case "[": {
      const characterClass = consumeGlobCharacterClass({
        pattern,
        startIndex: index,
      });
      if (characterClass === undefined) {
        source += "\\[";
      } else {
        source += characterClass.source;
        index = characterClass.endIndex;
      }
      break;
    }
    case "\\": {
      const next = pattern[index + 1];
      if (next === undefined) {
        source += "\\\\";
      } else {
        source += escapeRegExp({ value: next });
        index += 1;
      }
      break;
    }
    default:
      source += escapeRegExp({ value: char });
      break;
    }
  }

  source += "$";
  const translated = translatePosixCharacterClasses({
    source,
    characterClassMode: characterLocaleMode,
  });
  return new RegExp(
    translated.source,
    translated.requiresUnicode ? "u" : undefined,
  );
}

function resolveGrepPatternSyntax({
  occurrences,
}: {
  occurrences: readonly StandardArgvOccurrence<StandardArgvAction<"color">>[];
}): GrepPatternSyntax {
  let syntax: GrepPatternSyntax = "basic";
  let explicitSyntax: GrepPatternSyntax | undefined;

  const selectSyntax = ({
    selected,
  }: {
    selected: GrepPatternSyntax;
  }): void => {
    if (explicitSyntax !== undefined && explicitSyntax !== selected) {
      throw new Error("conflicting matchers specified");
    }
    explicitSyntax = selected;
    syntax = selected;
  };

  for (const { semantic } of occurrences) {
    for (const effect of grepOptionEffects({ action: semantic })) {
      switch (effect.key) {
      case "extendedRegexp":
        selectSyntax({ selected: "extended" });
        break;
      case "basicRegexp":
        selectSyntax({ selected: "basic" });
        break;
      case "perlRegexp":
        selectSyntax({ selected: "perl" });
        break;
      case "fixedStrings":
        selectSyntax({ selected: "fixed" });
        break;
      default:
        break;
      }
    }
  }

  return syntax;
}

function grepOptionEffects({ action }: { action: StandardArgvAction<"color"> }) {
  switch (action.kind) {
  case "effects":
    return action.effects;
  case "required-value":
  case "deferred":
    return [];
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled grep option action: ${JSON.stringify(_ex)}`);
  }
  }
}

function splitTopLevelPerlAlternatives({
  source,
}: {
  source: string;
}): string[] {
  const alternatives: string[] = [];
  let current = "";
  let groupDepth = 0;
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      current += character;
      if (index + 1 < source.length) {
        current += source[++index]!;
      }
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
      if (character === "(") {
        groupDepth += 1;
      }
      if (character === ")") {
        groupDepth = Math.max(0, groupDepth - 1);
      }
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

function translatePerlResetMatchStart({ source }: { source: string }): string {
  let segmentStart = 0;
  let segmentEnd = source.length;
  let wrapperCount = 0;
  if (source.includes('\\K')) {
    const groupEndIndexes = mapPerlGroupEndIndexes({ source });
    while (
      source.startsWith('(?:', segmentStart)
      && groupEndIndexes.get(segmentStart) === segmentEnd - 1
    ) {
      wrapperCount += 1;
      segmentStart += 3;
      segmentEnd -= 1;
    }
  }

  const translated = splitTopLevelPerlAlternatives({
    source: source.slice(segmentStart, segmentEnd),
  })
    .map((alternative) => {
      const markerIndices: number[] = [];
      let groupDepth = 0;
      let inBracket = false;

      for (let index = 0; index < alternative.length; index += 1) {
        const character = alternative[index]!;
        if (character === '\\') {
          const next = alternative[index + 1];
          if (next === 'K') {
            if (groupDepth !== 0 || inBracket) {
              throw new Error('unsupported \\K placement');
            }
            markerIndices.push(index);
          }
          index += next === undefined ? 0 : 1;
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
        if (!inBracket) {
          if (character === '(') {
            groupDepth += 1;
          }
          if (character === ')') {
            groupDepth = Math.max(0, groupDepth - 1);
          }
        }
      }

      if (markerIndices.length === 0) {
        return alternative;
      }
      const finalMarkerIndex = markerIndices.at(-1)!;
      let prefix = '';
      let markerSegmentStart = 0;
      for (const markerIndex of markerIndices.slice(0, -1)) {
        prefix += alternative.slice(markerSegmentStart, markerIndex);
        markerSegmentStart = markerIndex + 2;
      }
      prefix += alternative.slice(markerSegmentStart, finalMarkerIndex);
      const suffix = alternative.slice(finalMarkerIndex + 2);
      return prefix.length === 0 ? suffix : `(?<=${prefix})${suffix}`;
    })
    .join('|');

  return wrapperCount === 0
    ? translated
    : `${'(?:'.repeat(wrapperCount)}${translated}${')'.repeat(wrapperCount)}`;
}

function resolvePerlModifiers({
  enabled,
  disabled,
}: {
  enabled: string;
  disabled: string;
}): {
  ignoreCaseOverride: boolean | undefined;
  dotAllOverride: boolean | undefined;
  extendedMode: boolean;
} {
  const ignoreCaseOverride = enabled.includes("i")
    ? true
    : disabled.includes("i")
      ? false
      : undefined;
  return {
    ignoreCaseOverride,
    dotAllOverride: enabled.includes("s")
      ? true
      : disabled.includes("s")
        ? false
        : undefined,
    extendedMode: enabled.includes("x") && !disabled.includes("x"),
  };
}

function unwrapWholePerlModifierGroup({ source }: { source: string }):
  | {
      source: string;
      ignoreCaseOverride: boolean | undefined;
      dotAllOverride: boolean | undefined;
      extendedMode: boolean;
    }
  | undefined {
  const prefixMatch = /^\(\?([isx]*)(?:-([isx]+))?:/.exec(source);
  if (prefixMatch === null) {
    return undefined;
  }
  const enabled = prefixMatch[1] ?? "";
  const disabled = prefixMatch[2] ?? "";
  if (enabled.length === 0 && disabled.length === 0) {
    return undefined;
  }

  const prefixLength = prefixMatch[0].length;
  let groupDepth = 1;
  let inBracket = false;
  for (let index = prefixLength; index < source.length; index += 1) {
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
    if (inBracket) {
      continue;
    }
    if (character === "(") {
      groupDepth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    groupDepth -= 1;
    if (groupDepth !== 0) {
      continue;
    }
    if (index !== source.length - 1) {
      return undefined;
    }
    return {
      source: source.slice(prefixLength, index),
      ...resolvePerlModifiers({ enabled, disabled }),
    };
  }

  return undefined;
}

function consumeLeadingPerlModifiers({ source }: { source: string }):
  | {
      source: string;
      ignoreCaseOverride: boolean | undefined;
      dotAllOverride: boolean | undefined;
      extendedMode: boolean;
    }
  | undefined {
  const match = /^\(\?([isx]*)(?:-([isx]+))?\)/.exec(source);
  if (match === null) {
    return undefined;
  }
  const enabled = match[1] ?? "";
  const disabled = match[2] ?? "";
  if (enabled.length === 0 && disabled.length === 0) {
    return undefined;
  }
  return {
    source: source.slice(match[0].length),
    ...resolvePerlModifiers({ enabled, disabled }),
  };
}

type PerlModifierHeader = {
  readonly enabled: string,
  readonly disabled: string,
  readonly marker: ':' | ')',
  readonly endIndex: number,
};

function consumePerlModifierHeader({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): PerlModifierHeader | undefined {
  if (source[startIndex] !== '(' || source[startIndex + 1] !== '?') {
    return undefined;
  }
  let index = startIndex + 2;
  const enabledStart = index;
  while (source[index] === 'i' || source[index] === 's' || source[index] === 'x') {
    index += 1;
  }
  const enabled = source.slice(enabledStart, index);
  let disabled = '';
  if (source[index] === '-') {
    index += 1;
    const disabledStart = index;
    while (source[index] === 'i' || source[index] === 's' || source[index] === 'x') {
      index += 1;
    }
    if (index === disabledStart) {
      return undefined;
    }
    disabled = source.slice(disabledStart, index);
  }
  const marker = source[index];
  if (marker !== ':' && marker !== ')') {
    return undefined;
  }
  return { enabled, disabled, marker, endIndex: index + 1 };
}

function mapPerlGroupEndIndexes({ source }: { source: string }): ReadonlyMap<number, number> {
  const groupStarts: number[] = [];
  const groupEnds = new Map<number, number>();
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      index += index + 1 < source.length ? 1 : 0;
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
    if (inBracket) {
      continue;
    }
    if (character === '(') {
      groupStarts.push(index);
      continue;
    }
    if (character !== ')') {
      continue;
    }
    const groupStart = groupStarts.pop();
    if (groupStart !== undefined) {
      groupEnds.set(groupStart, index);
    }
  }
  return groupEnds;
}

function containsPerlLocalModifier({ source }: { source: string }): boolean {
  let inBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      index += index + 1 < source.length ? 1 : 0;
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
    if (inBracket || character !== '(' || source[index + 1] !== '?') {
      continue;
    }
    const modifier = consumePerlModifierHeader({ source, startIndex: index });
    if (modifier === undefined) {
      continue;
    }
    if (`${modifier.enabled}${modifier.disabled}`.length > 0) {
      return true;
    }
    index = modifier.endIndex - 1;
  }
  return false;
}

function findPerlEscapeEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  const escaped = source[startIndex + 1];
  if (escaped === undefined) {
    return startIndex;
  }
  const delimiter = source[startIndex + 2];
  if (
    (escaped === "p" ||
      escaped === "P" ||
      escaped === "u" ||
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
        const _ex: never = delimiter;
        throw new Error(`Unhandled PCRE reference delimiter: ${_ex}`);
      }
      }
    })();
    const end = source.indexOf(closing, startIndex + 3);
    return end === -1 ? startIndex + 1 : end;
  }
  if (escaped === "u" && /^[0-9A-Fa-f]{4}/.test(source.slice(startIndex + 2))) {
    return startIndex + 5;
  }
  if (escaped === "x" && /^[0-9A-Fa-f]{2}/.test(source.slice(startIndex + 2))) {
    return startIndex + 3;
  }
  if (escaped === "c" && source[startIndex + 2] !== undefined) {
    return startIndex + 2;
  }
  return startIndex + 1;
}

function findPerlCharacterClassEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number {
  let index = startIndex + 1;
  if (source[index] === "^") {
    index += 1;
  }
  if (source[index] === "]") {
    index += 1;
  }
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index = findPerlEscapeEnd({ source, startIndex: index });
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
    if (source[index] === "]") {
      return index;
    }
  }
  throw new Error("unterminated PCRE character class");
}

function appendAsciiCaseFoldedCharacter({
  target,
  character,
  ignoreCase,
}: {
  target: string;
  character: string;
  ignoreCase: boolean;
}): string {
  if (!ignoreCase) {
    return target + character;
  }
  if (!/[A-Za-z]/.test(character)) {
    if (character.toLocaleLowerCase() !== character.toLocaleUpperCase()) {
      throw new Error("non-ASCII scoped PCRE case folding is unsupported");
    }
    return target + character;
  }
  const lower = character.toLowerCase();
  const upper = character.toUpperCase();
  return `${target}[${lower}${upper}]`;
}

function translateAsciiCaseInsensitiveBracket({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): { source: string; endIndex: number } {
  const classEnd = findPerlCharacterClassEnd({ source, startIndex });
  let translated = "[";
  let index = startIndex + 1;
  if (source[index] === "^") {
    translated += source[index++]!;
  }
  if (source[index] === "]") {
    translated += source[index++]!;
  }

  for (; index < classEnd; index += 1) {
    const character = source[index]!;
    if (character === "\\") {
      const escapeEnd = findPerlEscapeEnd({ source, startIndex: index });
      translated += source.slice(index, escapeEnd + 1);
      index = escapeEnd;
      continue;
    }
    const nestedMarker = source[index + 1];
    if (
      character === "[" &&
      (nestedMarker === ":" || nestedMarker === "." || nestedMarker === "=")
    ) {
      const nestedEnd = source.indexOf(`${nestedMarker}]`, index + 2);
      if (nestedEnd === -1 || nestedEnd >= classEnd) {
        throw new Error("unterminated PCRE character class expression");
      }
      const expression = source.slice(index, nestedEnd + 2);
      translated +=
        expression === "[:lower:]" || expression === "[:upper:]"
          ? "[:alpha:]"
          : expression;
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
      if (/^[a-z]-[a-z]$/.test(range)) {
        translated += `${character.toUpperCase()}-${rangeEnd.toUpperCase()}`;
      }
      if (/^[A-Z]-[A-Z]$/.test(range)) {
        translated += `${character.toLowerCase()}-${rangeEnd.toLowerCase()}`;
      }
      if (
        !/^[A-Za-z]-[A-Za-z]$/.test(range) &&
        (character.toLocaleLowerCase() !== character.toLocaleUpperCase() ||
          rangeEnd.toLocaleLowerCase() !== rangeEnd.toLocaleUpperCase())
      ) {
        throw new Error("non-ASCII scoped PCRE case folding is unsupported");
      }
      index += 2;
      continue;
    }
    translated = appendAsciiCaseFoldedCharacter({
      target: translated,
      character,
      ignoreCase: true,
    });
  }

  return { source: `${translated}]`, endIndex: classEnd };
}

function translatePerlLocalModifiers({
  source,
  initialIgnoreCase,
  initialDotAll,
  initialExtendedMode,
}: {
  source: string,
  initialIgnoreCase: boolean,
  initialDotAll: boolean,
  initialExtendedMode: boolean,
}): string {
  type PerlTranslationRope = string | readonly PerlTranslationRope[];
  type TranslationFrame = {
    index: number,
    readonly endIndex: number,
    ignoreCase: boolean,
    dotAll: boolean,
    extendedMode: boolean,
    readonly parts: PerlTranslationRope[],
    readonly continuation: { readonly groupEndIndex: number } | undefined,
  };

  const groupEndIndexes = mapPerlGroupEndIndexes({ source });
  const frames: TranslationFrame[] = [{
    index: 0,
    endIndex: source.length,
    ignoreCase: initialIgnoreCase,
    dotAll: initialDotAll,
    extendedMode: initialExtendedMode,
    parts: [],
    continuation: undefined,
  }];
  let root: PerlTranslationRope | undefined;

  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.index >= frame.endIndex) {
      frames.pop();
      const completed: PerlTranslationRope = frame.parts;
      const continuation = frame.continuation;
      if (continuation === undefined) {
        root = completed;
        break;
      }
      const parent = frames.at(-1);
      if (parent === undefined) {
        throw new Error('PCRE modifier translation parent frame is missing');
      }
      parent.parts.push(['(?:', completed, ')']);
      parent.index = continuation.groupEndIndex + 1;
      continue;
    }

    const character = source[frame.index]!;
    if (character === '\\') {
      const escaped = source[frame.index + 1];
      if (
        frame.ignoreCase
        && (escaped === 'k'
          || escaped === 'g'
          || (escaped !== undefined && /[1-9]/u.test(escaped)))
      ) {
        throw new Error('case-insensitive PCRE backreferences are unsupported');
      }
      const escapeEnd = findPerlEscapeEnd({ source, startIndex: frame.index });
      frame.parts.push(source.slice(frame.index, Math.min(escapeEnd + 1, frame.endIndex)));
      frame.index = Math.min(escapeEnd + 1, frame.endIndex);
      continue;
    }
    if (character === '[') {
      if (!frame.ignoreCase) {
        const bracketEnd = findPerlCharacterClassEnd({ source, startIndex: frame.index });
        if (bracketEnd >= frame.endIndex) {
          throw new Error('unterminated PCRE character class');
        }
        frame.parts.push(source.slice(frame.index, bracketEnd + 1));
        frame.index = bracketEnd + 1;
        continue;
      }
      const bracket = translateAsciiCaseInsensitiveBracket({
        source,
        startIndex: frame.index,
      });
      if (bracket.endIndex >= frame.endIndex) {
        throw new Error('unterminated PCRE character class');
      }
      frame.parts.push(bracket.source);
      frame.index = bracket.endIndex + 1;
      continue;
    }
    if (frame.extendedMode && /\s/u.test(character)) {
      frame.index += 1;
      continue;
    }
    if (frame.extendedMode && character === '#') {
      while (frame.index + 1 < frame.endIndex && source[frame.index + 1] !== '\n') {
        frame.index += 1;
      }
      frame.index += 1;
      continue;
    }
    if (character === '.') {
      frame.parts.push(frame.dotAll ? '[\\s\\S]' : '.');
      frame.index += 1;
      continue;
    }
    if (character === '(' && source[frame.index + 1] === '?') {
      const modifier = consumePerlModifierHeader({ source, startIndex: frame.index });
      if (modifier !== undefined) {
        const nextIgnoreCase = modifier.enabled.includes('i')
          ? true
          : modifier.disabled.includes('i')
            ? false
            : frame.ignoreCase;
        const nextDotAll = modifier.enabled.includes('s')
          ? true
          : modifier.disabled.includes('s')
            ? false
            : frame.dotAll;
        const nextExtendedMode = modifier.enabled.includes('x')
          ? true
          : modifier.disabled.includes('x')
            ? false
            : frame.extendedMode;
        switch (modifier.marker) {
        case ')':
          frame.ignoreCase = nextIgnoreCase;
          frame.dotAll = nextDotAll;
          frame.extendedMode = nextExtendedMode;
          frame.index = modifier.endIndex;
          continue;
        case ':': {
          const groupEndIndex = groupEndIndexes.get(frame.index);
          if (groupEndIndex === undefined || groupEndIndex >= frame.endIndex) {
            throw new Error('unterminated PCRE modifier group');
          }
          frames.push({
            index: modifier.endIndex,
            endIndex: groupEndIndex,
            ignoreCase: nextIgnoreCase,
            dotAll: nextDotAll,
            extendedMode: nextExtendedMode,
            parts: [],
            continuation: { groupEndIndex },
          });
          continue;
        }
        default: {
          const _ex: never = modifier.marker;
          throw new Error(`Unhandled PCRE modifier marker: ${_ex}`);
        }
        }
      }

      if (/^[A-Za-z]$/u.test(source[frame.index + 3] ?? '')) {
        let index = frame.index + 4;
        while (/^[A-Za-z0-9_]$/u.test(source[index] ?? '')) {
          index += 1;
        }
        if (source[index] === '>') {
          frame.parts.push(source.slice(frame.index, index + 1));
          frame.index = index + 1;
          continue;
        }
      }
    }
    frame.parts.push(appendAsciiCaseFoldedCharacter({
      target: '',
      character,
      ignoreCase: frame.ignoreCase,
    }));
    frame.index += 1;
  }

  if (root === undefined) {
    throw new Error('PCRE modifier translation did not produce output');
  }
  const flattened: string[] = [];
  const pending: PerlTranslationRope[] = [root];
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

function translatePerlCharacterEscapes({
  source,
  extendedMode,
}: {
  source: string;
  extendedMode: boolean;
}): {
  source: string;
  requiresUnicode: boolean;
} {
  const verticalWhitespaceCharacters = String.raw`\n\v\f\r\x85\u2028\u2029`;
  let translated = "";
  let requiresUnicode = false;
  let inBracket = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "[" && !inBracket) {
      inBracket = true;
      translated += character;
      continue;
    }
    if (character === "]" && inBracket) {
      inBracket = false;
      translated += character;
      continue;
    }
    if (extendedMode && !inBracket && /\s/.test(character)) {
      continue;
    }
    if (extendedMode && !inBracket && character === "#") {
      while (index + 1 < source.length && source[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character !== "\\") {
      translated += character;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) {
      translated += character;
      continue;
    }
    index += 1;
    if (!inBracket && escaped === "Q") {
      const quoteEnd = source.indexOf(String.raw`\E`, index + 1);
      const literalEnd = quoteEnd === -1 ? source.length : quoteEnd;
      translated += escapeRegExp({
        value: source.slice(index + 1, literalEnd),
      });
      index = quoteEnd === -1 ? source.length - 1 : quoteEnd + 1;
      continue;
    }
    if ((escaped === "p" || escaped === "P") && source[index + 1] === "{") {
      const propertyEnd = source.indexOf("}", index + 2);
      if (propertyEnd !== -1) {
        translated += `\\${escaped}${source.slice(index + 1, propertyEnd + 1)}`;
        requiresUnicode = true;
        index = propertyEnd;
        continue;
      }
    }
    if (escaped === "x" && source[index + 1] === "{") {
      const codePointEnd = source.indexOf("}", index + 2);
      if (codePointEnd !== -1) {
        const hexadecimal = source.slice(index + 2, codePointEnd);
        const codePoint = /^[0-9A-Fa-f]+$/.test(hexadecimal)
          ? Number.parseInt(hexadecimal, 16)
          : Number.NaN;
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10_ffff
        ) {
          throw new Error("invalid PCRE code point escape");
        }
        translated += `\\u{${hexadecimal}}`;
        requiresUnicode = true;
        index = codePointEnd;
        continue;
      }
    }
    if (inBracket) {
      switch (escaped) {
      case "h":
        translated += String.raw`\t\p{Zs}`;
        requiresUnicode = true;
        break;
      case "v":
        translated += verticalWhitespaceCharacters;
        break;
      default:
        translated += `\\${escaped}`;
        break;
      }
      continue;
    }

    switch (escaped) {
    case "A":
      translated += "^";
      break;
    case "z":
    case "Z":
      translated += "$";
      break;
    case "h":
      translated += String.raw`[\t\p{Zs}]`;
      requiresUnicode = true;
      break;
    case "H":
      translated += String.raw`[^\t\p{Zs}]`;
      requiresUnicode = true;
      break;
    case "v":
      translated += `[${verticalWhitespaceCharacters}]`;
      break;
    case "V":
      translated += `[^${verticalWhitespaceCharacters}]`;
      break;
    case "R":
      translated += `(?:\\r\\n|[${verticalWhitespaceCharacters}])`;
      break;
    case "N":
      translated += String.raw`[^\n]`;
      break;
    default:
      translated += `\\${escaped}`;
      break;
    }
  }

  return { source: translated, requiresUnicode };
}

function translatePerlPattern({
  pattern,
  defaultIgnoreCase,
  forceManualModifiers,
}: {
  pattern: string;
  defaultIgnoreCase: boolean;
  forceManualModifiers: boolean;
}): {
  source: string;
  ignoreCaseOverride: boolean | undefined;
  dotAllOverride: boolean | undefined;
  requiresUnicode: boolean;
} {
  const scopedModifiers = unwrapWholePerlModifierGroup({ source: pattern });
  const leadingModifiers =
    scopedModifiers === undefined
      ? consumeLeadingPerlModifiers({ source: pattern })
      : undefined;
  const source = scopedModifiers?.source ?? leadingModifiers?.source ?? pattern;
  const ignoreCaseOverride =
    scopedModifiers?.ignoreCaseOverride ?? leadingModifiers?.ignoreCaseOverride;
  const dotAllOverride =
    scopedModifiers?.dotAllOverride ?? leadingModifiers?.dotAllOverride;
  const extendedMode =
    scopedModifiers?.extendedMode ?? leadingModifiers?.extendedMode ?? false;
  const modifierTranslatedSource = forceManualModifiers
    ? translatePerlLocalModifiers({
      source,
      initialIgnoreCase: ignoreCaseOverride ?? defaultIgnoreCase,
      initialDotAll: dotAllOverride ?? false,
      initialExtendedMode: extendedMode,
    })
    : source;
  const escaped = translatePerlCharacterEscapes({
    source: modifierTranslatedSource,
    extendedMode: forceManualModifiers ? false : extendedMode,
  });
  return {
    source: translatePerlResetMatchStart({ source: escaped.source }),
    ignoreCaseOverride: forceManualModifiers ? false : ignoreCaseOverride,
    dotAllOverride: forceManualModifiers ? false : dotAllOverride,
    requiresUnicode: escaped.requiresUnicode,
  };
}

function findBasicBracketExpressionEnd({
  source,
  startIndex,
}: {
  source: string;
  startIndex: number;
}): number | undefined {
  let index = startIndex + 1;
  if (source[index] === "^") {
    index += 1;
  }
  if (source[index] === "]") {
    index += 1;
  }

  while (index < source.length) {
    const marker = source[index + 1];
    if (
      source[index] === "[" &&
      (marker === ":" || marker === "." || marker === "=")
    ) {
      const subexpressionEnd = source.indexOf(`${marker}]`, index + 2);
      if (subexpressionEnd >= 0) {
        index = subexpressionEnd + 2;
        continue;
      }
    }
    if (source[index] === "\\" && index + 1 < source.length) {
      index += 2;
      continue;
    }
    if (source[index] === "]") {
      return index;
    }
    index += 1;
  }

  return undefined;
}

function escapeLiteralGnuBasicAsterisks({
  source,
}: {
  source: string;
}): string {
  let result = "";
  let hasRepeatableAtom = false;
  let previousWasAsteriskQuantifier = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (character === "[") {
      const bracketEnd = findBasicBracketExpressionEnd({
        source,
        startIndex: index,
      });
      if (bracketEnd !== undefined) {
        result += source.slice(index, bracketEnd + 1);
        hasRepeatableAtom = true;
        previousWasAsteriskQuantifier = false;
        index = bracketEnd;
        continue;
      }
    }

    if (character === "\\") {
      const next = source[index + 1];
      result += character;
      if (next === undefined) {
        hasRepeatableAtom = true;
        continue;
      }

      result += next;
      index += 1;
      if (next === "(" || next === "|") {
        hasRepeatableAtom = false;
      } else if (!"+?{".includes(next)) {
        hasRepeatableAtom = true;
      }
      previousWasAsteriskQuantifier = false;
      continue;
    }

    if (character === "^" && !hasRepeatableAtom) {
      result += character;
      previousWasAsteriskQuantifier = false;
      continue;
    }

    if (character === "$") {
      const endsBranch =
        index === source.length - 1 ||
        (source[index + 1] === "\\" &&
          (source[index + 2] === ")" || source[index + 2] === "|"));
      result += character;
      hasRepeatableAtom = !endsBranch;
      previousWasAsteriskQuantifier = false;
      continue;
    }

    if (character === "*") {
      if (!hasRepeatableAtom) {
        result += String.raw`\*`;
        hasRepeatableAtom = true;
        previousWasAsteriskQuantifier = false;
      } else if (!previousWasAsteriskQuantifier) {
        result += character;
        previousWasAsteriskQuantifier = true;
      }
      continue;
    }

    result += character;
    hasRepeatableAtom = true;
    previousWasAsteriskQuantifier = false;
  }

  return result;
}

function appendNewlineSeparatedPatterns({
  patterns,
  value,
}: {
  patterns: string[];
  value: string;
}): void {
  let startIndex = 0;
  while (true) {
    const separatorIndex = value.indexOf("\n", startIndex);
    if (separatorIndex === -1) {
      patterns.push(value.slice(startIndex));
      return;
    }
    patterns.push(value.slice(startIndex, separatorIndex));
    startIndex = separatorIndex + 1;
  }
}

function buildGrepRegex({
  patterns,
  syntax,
  wordRegexp,
  ignoreCase,
  exactLine,
  global,
  characterLocaleMode,
  asciiCaseInsensitive,
  nullData,
}: {
  patterns: string[];
  syntax: GrepPatternSyntax;
  wordRegexp: boolean;
  ignoreCase: boolean;
  exactLine: boolean;
  global: boolean;
  characterLocaleMode: WeshCharacterLocaleMode;
  asciiCaseInsensitive: boolean;
  nullData: boolean;
}): RegExp {
  let requiresUnicode = wordRegexp && characterLocaleMode === "unicode";
  const forceManualPerlModifiers =
    syntax === "perl" &&
    patterns.some((pattern) => {
      const scoped = unwrapWholePerlModifierGroup({ source: pattern });
      const leading =
        scoped === undefined
          ? consumeLeadingPerlModifiers({ source: pattern })
          : undefined;
      return containsPerlLocalModifier({
        source: scoped?.source ?? leading?.source ?? pattern,
      });
    });
  const perlCaseModes = new Set<boolean>();
  const perlDotAllModes = new Set<boolean>();
  const translatedPatterns: string[] = [];
  const translatedPatternSet = new Set<string>();
  for (const pattern of patterns) {
    let translatedPattern: string;
    switch (syntax) {
    case "fixed":
      translatedPattern = escapeRegExp({ value: pattern });
      break;
    case "basic": {
      const translated = translateBasicRegularExpression({
        source: escapeLiteralGnuBasicAsterisks({ source: pattern }),
        characterClassMode: characterLocaleMode,
        gnuWordOperators: true,
        basicOperatorMode: 'gnu',
        dotMode: nullData ? "non-null" : "non-newline",
        excludeSurrogateEscapes: characterLocaleMode === "unicode",
      });
      requiresUnicode ||= translated.requiresUnicode;
      translatedPattern = translated.source;
      break;
    }
    case "extended": {
      const translated = translateExtendedRegularExpression({
        source: pattern,
        characterClassMode: characterLocaleMode,
        gnuWordOperators: true,
        dotMode: nullData ? "non-null" : "non-newline",
        excludeSurrogateEscapes: characterLocaleMode === "unicode",
      });
      requiresUnicode ||= translated.requiresUnicode;
      translatedPattern = translated.source;
      break;
    }
    case "perl": {
      const perl = translatePerlPattern({
        pattern,
        defaultIgnoreCase: ignoreCase,
        forceManualModifiers: forceManualPerlModifiers,
      });
      perlCaseModes.add(perl.ignoreCaseOverride ?? ignoreCase);
      perlDotAllModes.add(perl.dotAllOverride ?? false);
      requiresUnicode ||= perl.requiresUnicode;
      const translated = translatePosixCharacterClasses({
        source: perl.source,
        characterClassMode: characterLocaleMode,
      });
      requiresUnicode ||= translated.requiresUnicode;
      translatedPattern = translated.source;
      break;
    }
    default: {
      const _ex: never = syntax;
      throw new Error(`Unhandled grep pattern syntax: ${_ex}`);
    }
    }
    const completePattern = exactLine
      ? `^(?:${translatedPattern})$`
      : translatedPattern;
    if (!translatedPatternSet.has(completePattern)) {
      translatedPatternSet.add(completePattern);
      translatedPatterns.push(completePattern);
    }
  }
  const patternSource =
    translatedPatterns.length === 0 ? "(?!)" : translatedPatterns.join("|");
  if (perlCaseModes.size > 1) {
    throw new Error("mixed PCRE inline case modifiers are unsupported");
  }
  if (perlDotAllModes.size > 1) {
    throw new Error("mixed PCRE inline dot-all modifiers are unsupported");
  }
  const effectiveIgnoreCase = (() => {
    switch (syntax) {
    case "basic":
    case "extended":
    case "fixed":
      return ignoreCase;
    case "perl":
      return perlCaseModes.values().next().value ?? ignoreCase;
    default: {
      const _ex: never = syntax;
      throw new Error(`Unhandled grep pattern syntax: ${_ex}`);
    }
    }
  })();
  const effectiveDotAll = (() => {
    switch (syntax) {
    case "basic":
    case "extended":
    case "fixed":
      return nullData;
    case "perl":
      return perlDotAllModes.values().next().value ?? false;
    default: {
      const _ex: never = syntax;
      throw new Error(`Unhandled grep pattern syntax: ${_ex}`);
    }
    }
  })();
  const wordCharacterSource = (() => {
    switch (characterLocaleMode) {
    case "ascii":
      return "A-Za-z0-9_";
    case "unicode":
      return String.raw`\p{L}\p{N}\p{M}_`;
    default: {
      const _ex: never = characterLocaleMode;
      throw new Error(`Unhandled grep character locale mode: ${_ex}`);
    }
    }
  })();
  const source = wordRegexp
    ? `(?<![${wordCharacterSource}])(?:${patternSource})(?![${wordCharacterSource}])`
    : patternSource;
  const compiledSource = asciiCaseInsensitive
    ? foldAsciiRegularExpressionSource({ source })
    : source;
  const flags = `${global ? "g" : ""}${effectiveIgnoreCase && !asciiCaseInsensitive ? "i" : ""}${effectiveDotAll ? "s" : ""}${requiresUnicode ? "u" : ""}`;
  return new RegExp(compiledSource, flags || undefined);
}

function parseNonNegativeInteger({
  value,
}: {
  value: unknown;
}): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/.test(numericText)) {
    return undefined;
  }

  const parsed = Number(numericText);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readAllStdinBytes({
  context,
}: {
  context: WeshCommandContext;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const buffer = new Uint8Array(64 * 1024);
    const { bytesRead } = await context.stdin.read({ buffer });
    if (bytesRead === 0) {
      break;
    }
    const chunk =
      bytesRead === buffer.byteLength ? buffer : buffer.slice(0, bytesRead);
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readLineFile({
  context,
  path,
  stripTrailingCarriageReturn,
}: {
  context: WeshCommandContext;
  path: string;
  stripTrailingCarriageReturn: boolean;
}): Promise<string[]> {
  const bytes =
    path === "-"
      ? await readAllStdinBytes({ context })
      : await readAllFileBytes({
        files: context.files,
        path: resolvePath({ cwd: context.cwd, path }),
      });
  const content = decodeCommandDataBytes({ bytes });
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (stripTrailingCarriageReturn) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.endsWith("\r")) {
        lines[index] = line.slice(0, -1);
      }
    }
  }
  return lines;
}

async function openGrepInputStream({
  context,
  file,
  entry,
}: {
  context: WeshCommandContext;
  file: string;
  entry?: WeshEntryRef;
}): Promise<ReadableStream<Uint8Array>> {
  if (file === "-") {
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffer = new Uint8Array(64 * 1024);
        const { bytesRead } = await context.stdin.read({ buffer });
        if (bytesRead === 0) {
          controller.close();
          return;
        }
        controller.enqueue(
          bytesRead === buffer.byteLength
            ? buffer
            : buffer.subarray(0, bytesRead),
        );
      },
    });
  }

  if (entry !== undefined) {
    const handle = await context.files.openEntry({
      entry,
      flags: {
        access: "read",
        creation: "never",
        truncate: "preserve",
        append: "preserve",
      },
    });
    return openHandleReadStream({ handle });
  }

  return await openFileReadStream({
    files: context.files,
    path: resolvePath({ cwd: context.cwd, path: file }),
  });
}

async function classifyGrepInputStream({
  stream,
  mode,
  nullData,
}: {
  stream: ReadableStream<Uint8Array>;
  mode: GrepBinaryFilesMode;
  nullData: boolean;
}): Promise<{
  stream: ReadableStream<Uint8Array>;
  isBinary: boolean;
}> {
  switch (mode) {
  case "text":
    return { stream, isBinary: false };
  case "binary":
  case "without-match":
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled grep binary mode: ${_ex}`);
  }
  }

  if (nullData) {
    return { stream, isBinary: false };
  }

  const reader = stream.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let isBinary = false;
  let reachedEnd = false;
  let readerReleased = false;
  const releaseReader = (): void => {
    if (readerReleased) {
      return;
    }
    reader.releaseLock();
    readerReleased = true;
  };

  try {
    while (prefixLength < GREP_BINARY_DETECTION_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }

      prefixChunks.push(value);
      prefixLength += value.byteLength;
      if (value.includes(0)) {
        isBinary = true;
        break;
      }
    }

    let prefixIndex = 0;
    const rebuiltStream = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const prefix = prefixChunks[prefixIndex];
        if (prefix !== undefined) {
          prefixIndex += 1;
          controller.enqueue(prefix);
          return;
        }

        if (reachedEnd) {
          controller.close();
          releaseReader();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          reachedEnd = true;
          controller.close();
          releaseReader();
          return;
        }

        controller.enqueue(value);
      },
      async cancel(reason): Promise<void> {
        if (!reachedEnd) {
          reachedEnd = true;
          await reader.cancel(reason);
        }
        releaseReader();
      },
    });

    return {
      stream: rebuiltStream,
      isBinary,
    };
  } catch (error: unknown) {
    if (!reachedEnd) {
      await reader.cancel(error);
    }
    releaseReader();
    throw error;
  }
}

function toGrepParsedValue<T extends string>({ parsed }: {
  parsed: { ok: true; value: T } | { ok: false; message: string };
}): { kind: "parsed"; value: T } | { kind: "invalid"; message: string } {
  return parsed.ok
    ? { kind: "parsed", value: parsed.value }
    : { kind: "invalid", message: parsed.message };
}

function parseGrepCountOption({ value, target }: {
  value: string;
  target: "max-count" | "context";
}): { kind: "parsed"; value: number } | { kind: "invalid"; message: string } {
  const parsed = parseNonNegativeInteger({ value });
  if (parsed !== undefined) {
    return { kind: "parsed", value: parsed };
  }
  switch (target) {
  case "max-count":
    return { kind: "invalid", message: "invalid max count" };
  case "context":
    return { kind: "invalid", message: `${value}: invalid context length argument` };
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled grep count option: ${_ex}`);
  }
  }
}

const grepOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: "extendedRegexp", value: true }] },
    forms: [
      { kind: 'short', name: "E", value: { kind: 'none' } },
      { kind: 'long', name: "extended-regexp", value: { kind: 'none' } },
    ],
    summary: "use extended regular expressions",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "basicRegexp", value: true }] },
    forms: [
      { kind: 'short', name: "G", value: { kind: 'none' } },
      { kind: 'long', name: "basic-regexp", value: { kind: 'none' } },
    ],
    summary: "use basic regular expressions",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "perlRegexp", value: true }] },
    forms: [
      { kind: 'short', name: "P", value: { kind: 'none' } },
      { kind: 'long', name: "perl-regexp", value: { kind: 'none' } },
    ],
    summary: "use Perl-compatible regular expressions",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "help", value: true }] },
    forms: [{ kind: 'long', name: "help", value: { kind: 'none' } }],
    summary: "display this help and exit",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "ignoreCase", value: true }] },
    forms: [
      { kind: 'short', name: "i", value: { kind: 'none' } },
      { kind: 'long', name: "ignore-case", value: { kind: 'none' } },
    ],
    summary: "ignore case distinctions",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "ignoreCase", value: true }] },
    forms: [{ kind: 'short', name: "y", value: { kind: 'none' } }],
    summary: "same as -i",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "ignoreCase", value: false }] },
    forms: [{ kind: 'long', name: "no-ignore-case", value: { kind: 'none' } }],
    summary: "do not ignore case distinctions",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "invertMatch", value: true }] },
    forms: [
      { kind: 'short', name: "v", value: { kind: 'none' } },
      { kind: 'long', name: "invert-match", value: { kind: 'none' } },
    ],
    summary: "select non-matching lines",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "lineNumber", value: true }] },
    forms: [
      { kind: 'short', name: "n", value: { kind: 'none' } },
      { kind: 'long', name: "line-number", value: { kind: 'none' } },
    ],
    summary: "print line numbers",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "byteOffset", value: true }] },
    forms: [
      { kind: 'short', name: "b", value: { kind: 'none' } },
      { kind: 'long', name: "byte-offset", value: { kind: 'none' } },
    ],
    summary: "print byte offsets",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "wordRegexp", value: true }] },
    forms: [
      { kind: 'short', name: "w", value: { kind: 'none' } },
      { kind: 'long', name: "word-regexp", value: { kind: 'none' } },
    ],
    summary: "match only whole words",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "exactLine", value: true }] },
    forms: [
      { kind: 'short', name: "x", value: { kind: 'none' } },
      { kind: 'long', name: "line-regexp", value: { kind: 'none' } },
    ],
    summary: "match only whole lines",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "fixedStrings", value: true }] },
    forms: [
      { kind: 'short', name: "F", value: { kind: 'none' } },
      { kind: 'long', name: "fixed-strings", value: { kind: 'none' } },
    ],
    summary: "treat patterns as literal strings",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "nullData", value: true }] },
    forms: [
      { kind: 'short', name: "z", value: { kind: 'none' } },
      { kind: 'long', name: "null-data", value: { kind: 'none' } },
    ],
    summary: "end input records with NUL instead of newline",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [] },
    forms: [
      { kind: 'short', name: "U", value: { kind: 'none' } },
      { kind: 'long', name: "binary", value: { kind: 'none' } },
    ],
    summary: "do not strip carriage returns at end of line",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "obsoleteUnixByteOffsets", value: true }] },
    forms: [
      { kind: 'short', name: "u", value: { kind: 'none' } },
      { kind: 'long', name: "unix-byte-offsets", value: { kind: 'none' } },
    ],
    summary: "report Unix-style byte offsets (obsolete no-op)",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "binaryFilesMode", value: "without-match" }] },
    forms: [{ kind: 'short', name: "I", value: { kind: 'none' } }],
    summary: "assume binary files contain no matches",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "binaryFilesMode", value: "text" }] },
    forms: [
      { kind: 'short', name: "a", value: { kind: 'none' } },
      { kind: 'long', name: "text", value: { kind: 'none' } },
    ],
    summary: "process binary files as text",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "binaryFilesMode", parse: ({ rawValue }: { rawValue: string }) => toGrepParsedValue({ parsed: parseBinaryFilesMode({ value: rawValue }) }) },
    forms: [{ kind: 'long', name: "binary-files", value: { kind: 'required', missingValueName: "TYPE" } }],
    summary: "assume TYPE is binary, text, or without-match",
    valueName: "TYPE",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "noMessages", value: true }] },
    forms: [
      { kind: 'short', name: "s", value: { kind: 'none' } },
      { kind: 'long', name: "no-messages", value: { kind: 'none' } },
    ],
    summary: "suppress error messages",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "quiet", value: true }] },
    forms: [
      { kind: 'short', name: "q", value: { kind: 'none' } },
      { kind: 'long', name: "quiet", value: { kind: 'none' } },
    ],
    summary: "suppress normal output",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "quiet", value: true }] },
    forms: [{ kind: 'long', name: "silent", value: { kind: 'none' } }],
    summary: "same as --quiet",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "countOnly", value: true }] },
    forms: [
      { kind: 'short', name: "c", value: { kind: 'none' } },
      { kind: 'long', name: "count", value: { kind: 'none' } },
    ],
    summary: "print only a count of matching lines",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "filesWithMatches", value: true }] },
    forms: [
      { kind: 'short', name: "l", value: { kind: 'none' } },
      { kind: 'long', name: "files-with-matches", value: { kind: 'none' } },
    ],
    summary: "print only names of matching files",
    category: "common",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "filesWithoutMatches", value: true }] },
    forms: [
      { kind: 'short', name: "L", value: { kind: 'none' } },
      { kind: 'long', name: "files-without-match", value: { kind: 'none' } },
    ],
    summary: "print only names of files without matches",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "onlyMatching", value: true }] },
    forms: [
      { kind: 'short', name: "o", value: { kind: 'none' } },
      { kind: 'long', name: "only-matching", value: { kind: 'none' } },
    ],
    summary: "print only matched text",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "noFilename", value: true }] },
    forms: [
      { kind: 'short', name: "h", value: { kind: 'none' } },
      { kind: 'long', name: "no-filename", value: { kind: 'none' } },
    ],
    summary: "suppress file name prefixes",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "withFilename", value: true }] },
    forms: [
      { kind: 'short', name: "H", value: { kind: 'none' } },
      { kind: 'long', name: "with-filename", value: { kind: 'none' } },
    ],
    summary: "always print file name prefixes",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "nullFilename", value: true }] },
    forms: [
      { kind: 'short', name: "Z", value: { kind: 'none' } },
      { kind: 'long', name: "null", value: { kind: 'none' } },
    ],
    summary: "end printed file names with NUL",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "initialTab", value: true }] },
    forms: [
      { kind: 'short', name: "T", value: { kind: 'none' } },
      { kind: 'long', name: "initial-tab", value: { kind: 'none' } },
    ],
    summary: "align line content on a tab stop",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "lineBuffered", value: true }] },
    forms: [{ kind: 'long', name: "line-buffered", value: { kind: 'none' } }],
    summary: "flush output after each reported line",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "recursive", value: true }] },
    forms: [
      { kind: 'short', name: "r", value: { kind: 'none' } },
      { kind: 'long', name: "recursive", value: { kind: 'none' } },
    ],
    summary: "search directories recursively",
    category: "common",
  },
  {
    semantic: { kind: 'required-value', key: "directories", parse: ({ rawValue }: { rawValue: string }) => toGrepParsedValue({ parsed: parseDirectoryAction({ value: rawValue }) }) },
    forms: [
      { kind: 'short', name: "d", value: { kind: 'required-attached-or-following', missingValueName: "action" } },
      { kind: 'long', name: "directories", value: { kind: 'required', missingValueName: "action" } },
    ],
    summary: "handle directories with ACTION",
    valueName: "ACTION",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "devices", parse: ({ rawValue }: { rawValue: string }) => toGrepParsedValue({ parsed: parseDeviceAction({ value: rawValue }) }) },
    forms: [
      { kind: 'short', name: "D", value: { kind: 'required-attached-or-following', missingValueName: "action" } },
      { kind: 'long', name: "devices", value: { kind: 'required', missingValueName: "action" } },
    ],
    summary: "handle devices with ACTION",
    valueName: "ACTION",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "recursive", value: true }, { key: "dereferenceRecursive", value: true },] },
    forms: [
      { kind: 'short', name: "R", value: { kind: 'none' } },
      { kind: 'long', name: "dereference-recursive", value: { kind: 'none' } },
    ],
    summary: "follow all symbolic links recursively",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "afterContext", parse: ({ rawValue }: { rawValue: string }) => parseGrepCountOption({ value: rawValue, target: 'context' }) },
    forms: [
      { kind: 'short', name: "A", value: { kind: 'required-attached-or-following', missingValueName: "lines" } },
      { kind: 'long', name: "after-context", value: { kind: 'required', missingValueName: "lines" } },
    ],
    summary: "print NUM trailing context lines",
    valueName: "NUM",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "beforeContext", parse: ({ rawValue }: { rawValue: string }) => parseGrepCountOption({ value: rawValue, target: 'context' }) },
    forms: [
      { kind: 'short', name: "B", value: { kind: 'required-attached-or-following', missingValueName: "lines" } },
      { kind: 'long', name: "before-context", value: { kind: 'required', missingValueName: "lines" } },
    ],
    summary: "print NUM leading context lines",
    valueName: "NUM",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "context", parse: ({ rawValue }: { rawValue: string }) => parseGrepCountOption({ value: rawValue, target: 'context' }) },
    forms: [
      { kind: 'short', name: "C", value: { kind: 'required-attached-or-following', missingValueName: "lines" } },
      { kind: 'long', name: "context", value: { kind: 'required', missingValueName: "lines" } },
    ],
    summary: "print NUM context lines",
    valueName: "NUM",
    category: "common",
  },
  {
    semantic: { kind: 'required-value', key: "groupSeparator", parse: undefined },
    forms: [{ kind: 'long', name: "group-separator", value: { kind: 'required', missingValueName: "separator" } }],
    summary: "use SEP between context groups",
    valueName: "SEP",
    category: "advanced",
  },
  {
    semantic: { kind: 'effects', effects: [{ key: "noGroupSeparator", value: true }] },
    forms: [{ kind: 'long', name: "no-group-separator", value: { kind: 'none' } }],
    summary: "do not print separators between context groups",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "maxCount", parse: ({ rawValue }: { rawValue: string }) => parseGrepCountOption({ value: rawValue, target: 'max-count' }) },
    forms: [
      { kind: 'short', name: "m", value: { kind: 'required-attached-or-following', missingValueName: "num" } },
      { kind: 'long', name: "max-count", value: { kind: 'required', missingValueName: "num" } },
    ],
    summary: "stop after NUM selected lines",
    valueName: "NUM",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "regexp", parse: undefined },
    forms: [
      { kind: 'short', name: "e", value: { kind: 'required-attached-or-following', missingValueName: "pattern" } },
      { kind: 'long', name: "regexp", value: { kind: 'required', missingValueName: "pattern" } },
    ],
    summary: "add a pattern",
    valueName: "PATTERN",
    category: "common",
  },
  {
    semantic: { kind: 'required-value', key: "patternFile", parse: undefined },
    forms: [
      { kind: 'short', name: "f", value: { kind: 'required-attached-or-following', missingValueName: "file" } },
      { kind: 'long', name: "file", value: { kind: 'required', missingValueName: "file" } },
    ],
    summary: "read patterns from file",
    valueName: "FILE",
    category: "common",
  },
  {
    semantic: { kind: 'required-value', key: "include", parse: undefined },
    forms: [{ kind: 'long', name: "include", value: { kind: 'required', missingValueName: "glob" } }],
    summary: "search only files matching GLOB",
    valueName: "GLOB",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "exclude", parse: undefined },
    forms: [{ kind: 'long', name: "exclude", value: { kind: 'required', missingValueName: "glob" } }],
    summary: "skip files matching GLOB",
    valueName: "GLOB",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "excludeFrom", parse: undefined },
    forms: [{ kind: 'long', name: "exclude-from", value: { kind: 'required', missingValueName: "file" } }],
    summary: "skip files matching patterns from FILE",
    valueName: "FILE",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "excludeDir", parse: undefined },
    forms: [{ kind: 'long', name: "exclude-dir", value: { kind: 'required', missingValueName: "glob" } }],
    summary: "skip directories matching GLOB",
    valueName: "GLOB",
    category: "advanced",
  },
  {
    semantic: { kind: 'required-value', key: "label", parse: undefined },
    forms: [{ kind: 'long', name: "label", value: { kind: 'required', missingValueName: "label" } }],
    summary: "use LABEL as the standard-input file name",
    valueName: "LABEL",
    category: "advanced",
  },
  {
    semantic: { kind: 'deferred', tag: 'color' },
    forms: [{ kind: 'long', name: "color", value: { kind: 'optional-inline' } }],
    summary: "control color output",
    valueName: "WHEN",
    category: "advanced",
  },
  {
    semantic: { kind: 'deferred', tag: 'color' },
    forms: [{ kind: 'long', name: "colour", value: { kind: 'optional-inline' } }],
    summary: "control color output",
    valueName: "WHEN",
    category: "advanced",
  },
] as const;

const grepArgvCatalog = defineArgvCatalog<StandardArgvAction<'color'>>({
  definitions: grepOptions,
  nonExecutableLongOptions: [],
});
const grepArgvHelp = defineArgvHelpPresentation({ catalog: grepArgvCatalog, rows: grepOptions });
const grepArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

function normalizeGrepContextOptions({ args }: { args: readonly string[] }): readonly string[] {
  const isContextShorthand = ({ token }: { token: string }): boolean => /^-\d+$/u.test(token);
  if (!args.some(token => isContextShorthand({ token }))) {
    return args;
  }

  // Mark each unclaimed -NUM as a context occurrence. Its original digits
  // stay in args so only a shorthand selected for output needs validation.
  const normalized = [...args];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      break;
    }
    if (isContextShorthand({ token })) {
      normalized[index] = "--context=0";
      continue;
    }
    if (token.startsWith("--")) {
      const analysis = analyzeArgvLongForm({ token, catalog: grepArgvCatalog, longNameMatch: grepArgvPolicy.longNameMatch });
      if (analysis.kind === "matched" && analysis.value.kind === "following-required") {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-")) {
      continue;
    }
    shortOptions: for (let offset = 1; offset < token.length;) {
      const analysis = analyzeArgvShortForm({ token, bodyOffset: offset, prefix: "-", catalog: grepArgvCatalog });
      switch (analysis.kind) {
      case "unknown":
        break shortOptions;
      case "matched":
        switch (analysis.value.kind) {
        case "following-required":
          index += 1;
          break;
        case "none":
        case "inline":
        case "following-optional":
          break;
        default: {
          const _ex: never = analysis.value;
          throw new Error(`Unhandled grep option value claim: ${JSON.stringify(_ex)}`);
        }
        }
        offset = analysis.nextBodyOffset;
        break;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled grep short option analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }
  return normalized;
}

export const grepCommandImplementation: WeshCommandImplementation = {
  fn: async ({
    context,
  }: {
    context: WeshCommandContext;
  }): Promise<WeshCommandResult> => {
    const originalArgs = context.args;
    const args = normalizeGrepContextOptions({ args: originalArgs });
    const parsedArgs = stopArgvAtFirstEarlyExit({
      args,
      catalog: grepArgvCatalog,
      policy: grepArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, catalog: grepArgvCatalog, policy: grepArgvPolicy });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      if (diagnostic.kind === "invalid_option_value" &&
        (diagnostic.message === "invalid max count" || diagnostic.message.endsWith(": invalid context length argument"))) {
        await context.text().error({ text: `grep: ${diagnostic.message}\n` });
      } else {
        await writeCommandUsageError({
          context,
          command: "grep",
          message: `grep: ${diagnostic.message}`,
          usageSummary: formatArgvUsageSummary({ presentation: grepArgvHelp }),
        });
      }
      return { exitCode: 2 };
    }

    const occurrences = parsed.occurrences ?? [];
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: "grep",
        optionLines: formatArgvOptionHelp({ presentation: grepArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const maxCount = (parsed.optionValues.maxCount as number | undefined) ?? Number.POSITIVE_INFINITY;
    const characterLocaleMode = resolveCharacterLocaleMode({
      env: context.env,
    });
    const bufferedStdout = createBufferedGrepWriter({
      handle: context.stdout,
      maxBufferLength: parsed.optionValues.lineBuffered === true ? 1 : 16384,
    });
    if (parsed.optionValues.obsoleteUnixByteOffsets === true) {
      await text.error({
        text: "grep: warning: --unix-byte-offsets (-u) is obsolete\n",
      });
    }
    const patterns: string[] = [];
    const fileSelectionRules: GrepFileSelectionRule[] = [];
    const excludeDirPatterns: RegExp[] = [];
    let hasExplicitPatternSource = false;

    for (const { semantic, value } of occurrences) {
      if (semantic.kind !== "required-value" || value.kind === "none") {
        continue;
      }

      try {
        switch (semantic.key) {
        case "regexp":
          hasExplicitPatternSource = true;
          appendNewlineSeparatedPatterns({
            patterns,
            value: value.rawValue,
          });
          break;
        case "patternFile": {
          hasExplicitPatternSource = true;
          const filePatterns = await readLineFile({
            context,
            path: value.rawValue,
            stripTrailingCarriageReturn: false,
          });
          for (const pattern of filePatterns) {
            patterns.push(pattern);
          }
          break;
        }
        case "include":
        case "exclude":
          fileSelectionRules.push({
            include: semantic.key === "include",
            pattern: globToRegExp({
              pattern: value.rawValue,
              characterLocaleMode,
            }),
          });
          break;
        case "excludeFrom": {
          const excludeGlobs = await readLineFile({
            context,
            path: value.rawValue,
            stripTrailingCarriageReturn: true,
          });
          for (const pattern of excludeGlobs) {
            fileSelectionRules.push({
              include: false,
              pattern: globToRegExp({ pattern, characterLocaleMode }),
            });
          }
          break;
        }
        case "excludeDir":
          excludeDirPatterns.push(
            globToRegExp({
              pattern: value.rawValue,
              characterLocaleMode,
            }),
          );
          break;
        default:
          break;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `grep: ${value.rawValue}: ${message}\n` });
        return { exitCode: 2 };
      }
    }

    const files = [...parsed.positionals];
    if (patterns.length === 0 && !hasExplicitPatternSource) {
      const implicitPattern = files.shift();
      if (implicitPattern === undefined) {
        await writeCommandUsageError({
          context,
          command: "grep",
          message: "grep: missing pattern operand",
          usageSummary: formatArgvUsageSummary({ presentation: grepArgvHelp }),
        });
        return { exitCode: 1 };
      }
      appendNewlineSeparatedPatterns({ patterns, value: implicitPattern });
    }

    const exactLine = parsed.optionValues.exactLine === true;
    const ignoreCase = parsed.optionValues.ignoreCase === true;
    const wordRegexp = parsed.optionValues.wordRegexp === true;
    const nullData = parsed.optionValues.nullData === true;
    const nullFilename = parsed.optionValues.nullFilename === true;
    const initialTab = parsed.optionValues.initialTab === true;
    const invertMatch = parsed.optionValues.invertMatch === true;
    const noSelectedRecordIsPossible =
      invertMatch && !exactLine && !wordRegexp && patterns.includes("");
    const colorValue = parsed.deferred.at(-1)?.value;
    const parsedColorMode = colorValue !== undefined && colorValue.kind !== "none"
      ? parseColorMode({ value: colorValue.rawValue })
      : { ok: true as const, value: "never" as const };
    if (!parsedColorMode.ok) {
      await writeCommandUsageError({
        context,
        command: "grep",
        message: `grep: ${parsedColorMode.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: grepArgvHelp }),
      });
      return { exitCode: 2 };
    }
    const colorMode: GrepColorMode = parsedColorMode.value;
    const colorConfiguration = (() => {
      switch (colorMode) {
      case "always":
        return resolveGrepColorPalette({
          grepColors: context.env.get("GREP_COLORS"),
          deprecatedGrepColor: context.env.get("GREP_COLOR"),
        });
      case "never":
        return undefined;
      default: {
        const _ex: never = colorMode;
        throw new Error(`Unhandled grep color mode: ${_ex}`);
      }
      }
    })();
    if (colorConfiguration?.shouldWarnAboutDeprecatedGrepColor === true) {
      const deprecatedGrepColor = context.env.get("GREP_COLOR")!;
      await text.error({
        text: `grep: warning: GREP_COLOR='${deprecatedGrepColor}' is deprecated; use GREP_COLORS='mt=${deprecatedGrepColor}'\n`,
      });
    }
    const colorPalette = colorConfiguration?.palette;
    let syntax: GrepPatternSyntax;
    try {
      syntax = resolveGrepPatternSyntax({
        occurrences,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `grep: ${message}\n` });
      return { exitCode: 2 };
    }
    if (syntax === "perl" && patterns.length > 1) {
      await text.error({
        text: "grep: the -P option only supports a single pattern\n",
      });
      return { exitCode: 2 };
    }
    const asciiCaseInsensitive =
      characterLocaleMode === "ascii" && ignoreCase && syntax !== "perl";

    let regex: RegExp;
    let globalRegex: RegExp;
    try {
      regex = buildGrepRegex({
        patterns,
        syntax,
        wordRegexp,
        ignoreCase,
        exactLine,
        global: false,
        characterLocaleMode,
        asciiCaseInsensitive,
        nullData,
      });
      globalRegex = buildGrepRegex({
        patterns,
        syntax,
        wordRegexp,
        ignoreCase,
        exactLine,
        global: true,
        characterLocaleMode,
        asciiCaseInsensitive,
        nullData,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `grep: ${message}\n` });
      return { exitCode: 2 };
    }
    const hasUnsafeBacktracking = hasPotentiallyUnsafeBacktrackingStructure({
      source: regex.source,
    });

    interface GrepMatch {
      readonly index: number;
      readonly text: string;
    }

    const iterateMatches = function* ({
      line,
      matchLine,
    }: {
      line: string;
      matchLine: string;
    }): Generator<GrepMatch> {
      switch (syntax) {
      case "perl":
        globalRegex.lastIndex = 0;
        for (const match of matchLine.matchAll(globalRegex)) {
          const index = match.index ?? 0;
          if (match[0].length > 0) {
            yield { index, text: line.slice(index, index + match[0].length) };
          }
        }
        return;
      case "basic":
      case "extended":
      case "fixed": {
        let searchIndex = 0;
        while (searchIndex <= line.length) {
          const match = findPosixLeftmostLongestMatch({
            regex: globalRegex,
            source: matchLine,
            startIndex: searchIndex,
          });
          if (match === undefined) {
            return;
          }
          if (match.text.length > 0) {
            yield {
              index: match.index,
              text: line.slice(match.index, match.index + match.text.length),
            };
            searchIndex = match.index + match.text.length;
            continue;
          }
          if (match.index >= line.length) {
            return;
          }
          const codePoint = line.codePointAt(match.index);
          searchIndex =
              match.index +
              (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
        }
        return;
      }
      default: {
        const _ex: never = syntax;
        throw new Error(`Unhandled grep pattern syntax: ${_ex}`);
      }
      }
    };

    const beforeContext = parsed.optionValues.beforeContext as number | undefined;
    const afterContext = parsed.optionValues.afterContext as number | undefined;
    let bothContext = parsed.optionValues.context as number | undefined;
    if (args !== originalArgs && (beforeContext === undefined || afterContext === undefined)) {
      const contextOption = occurrences.findLast(({ semantic }) => semantic.kind === "required-value" && semantic.key === "context");
      if (contextOption !== undefined && originalArgs[contextOption.argvIndex] !== args[contextOption.argvIndex]) {
        const rawValue = originalArgs[contextOption.argvIndex]!.slice(1);
        const value = parseNonNegativeInteger({ value: rawValue });
        if (value === undefined) {
          await text.error({ text: `grep: ${rawValue}: invalid context length argument\n` });
          return { exitCode: 2 };
        }
        bothContext = value;
      }
    }
    const before = beforeContext ?? bothContext ?? 0;
    const after = afterContext ?? bothContext ?? 0;
    const contextRequested = beforeContext !== undefined || afterContext !== undefined || bothContext !== undefined;
    let groupSeparator: string | undefined = "--";
    for (const { semantic, value } of occurrences) {
      if (semantic.kind === "required-value" && semantic.key === "groupSeparator" && value.kind !== "none") {
        groupSeparator = value.rawValue;
      }
      if (grepOptionEffects({ action: semantic }).some(effect => effect.key === "noGroupSeparator")) {
        groupSeparator = undefined;
      }
    }
    const inputRecordDelimiterByte = nullData ? 0x00 : 0x0a;
    const outputRecordTerminator = nullData ? "\0" : "\n";
    const outputRecordTerminatorBytes = GREP_TEXT_ENCODER.encode(
      outputRecordTerminator,
    );
    const quiet = parsed.optionValues.quiet === true;
    const noMessages = parsed.optionValues.noMessages === true;
    let directoryAction: GrepDirectoryAction = "read";
    for (const { semantic, value } of occurrences) {
      if (semantic.kind === "required-value" && semantic.key === "directories" && value.kind !== "none") {
        directoryAction = value.rawValue as GrepDirectoryAction;
      }
      if (grepOptionEffects({ action: semantic }).some(effect => effect.key === "recursive" && effect.value === true)) {
        directoryAction = "recurse";
      }
    }
    const recursive = directoryAction === "recurse";
    const recursiveMode: GrepRecursiveMode | undefined = recursive
      ? parsed.optionValues.dereferenceRecursive === true
        ? "logical"
        : "command-line"
      : undefined;
    const deviceAction =
      parsed.optionValues.devices === undefined
        ? "read"
        : (parsed.optionValues.devices as GrepDeviceAction);
    const binaryFilesMode =
      parsed.optionValues.binaryFilesMode === undefined
        ? "binary"
        : (parsed.optionValues.binaryFilesMode as GrepBinaryFilesMode);
    let fileListOutputMode:
      | Extract<GrepOutputMode, "files-with-matches" | "files-without-match">
      | undefined;
    let countOnly = false;
    let onlyMatching = false;
    let filenameMode: "auto" | "always" | "never" = "auto";
    for (const { semantic } of occurrences) {
      for (const effect of grepOptionEffects({ action: semantic })) {
        if (effect.key === "countOnly") {
          countOnly = true;
        }
        if (effect.key === "filesWithMatches") {
          fileListOutputMode = "files-with-matches";
        }
        if (effect.key === "filesWithoutMatches") {
          fileListOutputMode = "files-without-match";
        }
        if (effect.key === "onlyMatching") {
          onlyMatching = true;
        }
        if (effect.key === "noFilename") {
          filenameMode = "never";
        }
        if (effect.key === "withFilename") {
          filenameMode = "always";
        }
      }
    }
    const outputMode: GrepOutputMode =
      fileListOutputMode ??
      (countOnly ? "count" : undefined) ??
      (onlyMatching ? "only-matching" : "lines");
    const showFilename = (() => {
      switch (filenameMode) {
      case "never":
        return false;
      case "always":
        return true;
      case "auto":
        return recursive || files.length > 1;
      default: {
        const _ex: never = filenameMode;
        throw new Error(`Unhandled filename mode: ${_ex}`);
      }
      }
    })();
    let sawMatch = false;
    let sawError = false;
    let printedAnyLineGroup = false;
    let printedAnyOnlyMatchingContextGroup = false;

    const reportSearchError = async ({
      displayName,
      error,
    }: {
      displayName: string;
      error: unknown;
    }): Promise<void> => {
      sawError = true;
      if (noMessages) {
        return;
      }
      const message = getPathErrorReason({ error })
        ?? (error instanceof Error ? error.message : String(error));
      await text.error({ text: `grep: ${displayName}: ${message}\n` });
    };

    const colorizeOutput = ({
      value,
      capability,
    }: {
      value: string;
      capability: GrepColorCapability;
    }): string =>
      colorPalette === undefined
        ? value
        : colorizeGrepText({ text: value, palette: colorPalette, capability });

    const appendFilenamePrefix = ({
      output,
      name,
      separator,
    }: {
      output: string;
      name: string | undefined;
      separator: ":" | "-";
    }): string => {
      if (name === undefined || !showFilename) {
        return output;
      }
      const filename = colorizeOutput({ value: name, capability: "filename" });
      if (nullFilename) {
        return `${output}${filename}\0`;
      }
      const coloredSeparator = colorizeOutput({
        value: separator,
        capability: "separator",
      });
      return `${output}${filename}${coloredSeparator}`;
    };

    const buildReportedPrefix = ({
      name,
      separator,
      lineNumber,
      byteOffset,
      numericFieldWidth,
      hasContent,
    }: {
      name: string | undefined;
      separator: ":" | "-";
      lineNumber: number;
      byteOffset: number;
      numericFieldWidth: number;
      hasContent: boolean;
    }): string => {
      let output = appendFilenamePrefix({ output: "", name, separator });
      const appendNumber = ({
        value,
        capability,
      }: {
        value: number;
        capability: Extract<GrepColorCapability, "lineNumber" | "byteOffset">;
      }): void => {
        const formatted = initialTab
          ? String(value).padStart(numericFieldWidth, " ")
          : String(value);
        output += colorizeOutput({ value: formatted, capability });
        output += colorizeOutput({ value: separator, capability: "separator" });
      };
      if (parsed.optionValues.lineNumber === true) {
        appendNumber({ value: lineNumber, capability: "lineNumber" });
      }
      if (parsed.optionValues.byteOffset === true) {
        appendNumber({ value: byteOffset, capability: "byteOffset" });
      }
      if (initialTab && output.length > 0 && hasContent) {
        output += "\t";
      }
      return output;
    };

    const writeFilenameOnly = async ({
      name,
    }: {
      name: string;
    }): Promise<void> => {
      const filename = colorizeOutput({ value: name, capability: "filename" });
      await bufferedStdout.write({
        text: `${filename}${nullFilename ? "\0" : "\n"}`,
      });
    };

    const shouldSearchFile = ({
      displayPath,
    }: {
      displayPath: string;
    }): boolean => {
      const name = basename({ path: displayPath });
      let included = fileSelectionRules[0]?.include !== true;
      for (const rule of fileSelectionRules) {
        if (rule.pattern.test(name)) {
          included = rule.include;
        }
      }
      return included;
    };

    interface ContextLine {
      line: string;
      lineNumber: number;
      byteOffset: number;
      bytes: Uint8Array | undefined;
      selected: boolean;
    }

    class ContextLineRing {
      private readonly capacity: number;
      private readonly values: ContextLine[] = [];
      private nextIndex = 0;

      constructor({ capacity }: { capacity: number }) {
        this.capacity = capacity;
      }

      push({ value }: { value: ContextLine }): void {
        if (this.capacity === 0) {
          return;
        }
        if (this.values.length < this.capacity) {
          this.values.push(value);
          if (this.values.length === this.capacity) {
            this.nextIndex = 0;
          }
          return;
        }
        this.values[this.nextIndex] = value;
        this.nextIndex = (this.nextIndex + 1) % this.capacity;
      }

      *valuesAfter({
        lineNumber,
      }: {
        lineNumber: number;
      }): Generator<ContextLine> {
        const count = this.values.length;
        if (count === 0) {
          return;
        }
        const startIndex = count < this.capacity ? 0 : this.nextIndex;
        for (let offset = 0; offset < count; offset += 1) {
          const value = this.values[(startIndex + offset) % count]!;
          if (value.lineNumber > lineNumber) {
            yield value;
          }
        }
      }
    }

    const colorizeReportedLine = ({
      line,
      selected,
    }: {
      line: string;
      selected: boolean;
    }): string => {
      if (colorPalette === undefined) {
        return line;
      }
      const lineCapability = resolveGrepLineColorCapability({
        selected,
        invertMatch,
        palette: colorPalette,
      });
      const matchCapability: Extract<
        GrepColorCapability,
        "selectedMatch" | "contextMatch"
      > = selected ? "selectedMatch" : "contextMatch";
      const lineBegin = beginGrepColor({
        palette: colorPalette,
        capability: lineCapability,
      });
      const lineColorActive = lineBegin.length > 0;
      let output = lineBegin;
      let lineColorCurrentlyActive = lineColorActive;
      let cursor = 0;
      const matchLine = asciiCaseInsensitive
        ? foldAsciiCase({ value: line })
        : line;
      for (const match of iterateMatches({ line, matchLine })) {
        output += line.slice(cursor, match.index);
        const matchBegin = beginGrepColor({
          palette: colorPalette,
          capability: matchCapability,
        });
        if (matchBegin.length === 0) {
          output += match.text;
        } else {
          output += `${matchBegin}${match.text}${endGrepColor({ palette: colorPalette })}`;
          lineColorCurrentlyActive = false;
          const matchEnd = match.index + match.text.length;
          if (lineColorActive && matchEnd < line.length) {
            output += lineBegin;
            lineColorCurrentlyActive = true;
          }
        }
        cursor = match.index + match.text.length;
      }
      output += line.slice(cursor);
      if (lineColorCurrentlyActive) {
        output += endGrepColor({ palette: colorPalette });
      }
      return output;
    };

    const colorizeReportedLineBytes = ({
      line,
      bytes,
      selected,
    }: {
      line: string;
      bytes: Uint8Array;
      selected: boolean;
    }): readonly GrepOutputChunk[] => {
      if (colorPalette === undefined) {
        return [bytes];
      }

      const lineCapability = resolveGrepLineColorCapability({
        selected,
        invertMatch,
        palette: colorPalette,
      });
      const matchCapability: Extract<
        GrepColorCapability,
        "selectedMatch" | "contextMatch"
      > = selected ? "selectedMatch" : "contextMatch";
      const lineBegin = beginGrepColor({
        palette: colorPalette,
        capability: lineCapability,
      });
      const lineColorActive = lineBegin.length > 0;
      const values: GrepOutputChunk[] = [];
      if (lineColorActive) {
        values.push(lineBegin);
      }
      let lineColorCurrentlyActive = lineColorActive;
      let cursorByteOffset = 0;
      const matchLine = asciiCaseInsensitive
        ? foldAsciiCase({ value: line })
        : line;
      const byteOffsetTracker = createUtf8ByteOffsetTracker({
        text: line,
        baseByteOffset: 0,
      });
      for (const match of iterateMatches({ line, matchLine })) {
        const matchByteOffset = byteOffsetTracker.getByteOffset({
          codeUnitIndex: match.index,
        });
        const matchEndByteOffset = byteOffsetTracker.getByteOffset({
          codeUnitIndex: match.index + match.text.length,
        });
        values.push(bytes.subarray(cursorByteOffset, matchByteOffset));
        const matchBegin = beginGrepColor({
          palette: colorPalette,
          capability: matchCapability,
        });
        if (matchBegin.length === 0) {
          values.push(bytes.subarray(matchByteOffset, matchEndByteOffset));
        } else {
          values.push(
            matchBegin,
            bytes.subarray(matchByteOffset, matchEndByteOffset),
            endGrepColor({ palette: colorPalette }),
          );
          lineColorCurrentlyActive = false;
          if (lineColorActive && matchEndByteOffset < bytes.byteLength) {
            values.push(lineBegin);
            lineColorCurrentlyActive = true;
          }
        }
        cursorByteOffset = matchEndByteOffset;
      }
      values.push(bytes.subarray(cursorByteOffset));
      if (lineColorCurrentlyActive) {
        values.push(endGrepColor({ palette: colorPalette }));
      }
      return values;
    };

    const writeReportedLine = async ({
      line,
      bytes,
      lineNumber,
      byteOffset,
      selected,
      name,
      numericFieldWidth,
    }: {
      line: string;
      bytes: Uint8Array | undefined;
      lineNumber: number;
      byteOffset: number;
      selected: boolean;
      name?: string;
      numericFieldWidth: number;
    }): Promise<void> => {
      const separator = selected ? ":" : "-";
      const output = buildReportedPrefix({
        name,
        separator,
        lineNumber,
        byteOffset,
        numericFieldWidth,
        hasContent: (bytes?.byteLength ?? line.length) > 0,
      });
      if (bytes !== undefined) {
        await bufferedStdout.writeChunks({
          values: [
            output,
            ...colorizeReportedLineBytes({ line, bytes, selected }),
            outputRecordTerminatorBytes,
          ],
        });
        return;
      }

      const reportedLine = colorizeReportedLine({ line, selected });
      await bufferedStdout.write({
        text: `${output}${reportedLine}${outputRecordTerminator}`,
      });
    };

    const writeOnlyMatchingLine = async ({
      contextLine,
      reportAsSelected,
      name,
      numericFieldWidth,
    }: {
      contextLine: ContextLine;
      reportAsSelected: boolean;
      name: string | undefined;
      numericFieldWidth: number;
    }): Promise<void> => {
      const { line, lineNumber, byteOffset, bytes, ...unhandledContextLine } =
        contextLine;
      unhandledContextLine satisfies { selected: boolean };
      const matchLine = asciiCaseInsensitive
        ? foldAsciiCase({ value: line })
        : line;
      const byteOffsetTracker =
        bytes === undefined
          ? undefined
          : createUtf8ByteOffsetTracker({
            text: line,
            baseByteOffset: byteOffset,
          });
      for (const match of iterateMatches({ line, matchLine })) {
        const matchByteOffset =
          byteOffsetTracker?.getByteOffset({
            codeUnitIndex: match.index,
          }) ?? byteOffset;
        const output = buildReportedPrefix({
          name,
          separator: reportAsSelected ? ":" : "-",
          lineNumber,
          byteOffset: matchByteOffset,
          numericFieldWidth,
          hasContent: true,
        });
        if (bytes !== undefined && byteOffsetTracker !== undefined) {
          const matchEndByteOffset = byteOffsetTracker.getByteOffset({
            codeUnitIndex: match.index + match.text.length,
          });
          const relativeStart = matchByteOffset - byteOffset;
          const relativeEnd = matchEndByteOffset - byteOffset;
          const capability = reportAsSelected
            ? "selectedMatch"
            : "contextMatch";
          const matchBegin =
            colorPalette === undefined
              ? ""
              : beginGrepColor({ palette: colorPalette, capability });
          const matchEnd =
            colorPalette === undefined || matchBegin.length === 0
              ? ""
              : endGrepColor({ palette: colorPalette });
          await bufferedStdout.writeChunks({
            values: [
              output,
              matchBegin,
              bytes.subarray(relativeStart, relativeEnd),
              matchEnd,
              outputRecordTerminatorBytes,
            ],
          });
          continue;
        }

        await bufferedStdout.write({
          text: `${output}${colorizeOutput({
            value: match.text,
            capability: reportAsSelected ? "selectedMatch" : "contextMatch",
          })}${outputRecordTerminator}`,
        });
      }
    };

    const processStream = async ({
      stream,
      name,
      numericFieldWidth,
    }: {
      stream: ReadableStream<Uint8Array>;
      name?: string;
      numericFieldWidth: number;
    }): Promise<GrepFileReport> => {
      const state = {
        matched: false,
        selectedLineCount: 0,
      };
      if (maxCount === 0) {
        await stream.cancel();
        if (
          !quiet &&
          outputMode === "files-without-match" &&
          name !== undefined
        ) {
          await writeFilenameOnly({ name });
        }
        return state;
      }
      const previousLines = new ContextLineRing({ capacity: before });
      let lineNumber = 0;
      let lineByteOffset = 0;
      let remainingAfterLines = 0;
      let lastPrintedLineNumber = 0;
      let printedAnyGroup = false;
      let startedAnyOnlyMatchingContextGroup = false;
      let lastOnlyMatchingContextGroupLineNumber = 0;
      let stop = false;

      const writeContextGroupSeparatorIfNeeded = async ({
        firstLineNumber,
      }: {
        firstLineNumber: number;
      }): Promise<void> => {
        const startsAnotherFileGroup = printedAnyLineGroup && !printedAnyGroup;
        const startsSeparatedGroupInSameFile =
          printedAnyGroup && firstLineNumber > lastPrintedLineNumber + 1;
        if (
          contextRequested &&
          groupSeparator !== undefined &&
          (startsAnotherFileGroup || startsSeparatedGroupInSameFile)
        ) {
          const reportedSeparator = colorizeOutput({
            value: groupSeparator,
            capability: "separator",
          });
          await bufferedStdout.write({ text: `${reportedSeparator}\n` });
        }
      };

      const startOnlyMatchingContextGroup = async ({
        firstLineNumber,
      }: {
        firstLineNumber: number;
      }): Promise<void> => {
        const startsAnotherFileGroup =
          printedAnyOnlyMatchingContextGroup &&
          !startedAnyOnlyMatchingContextGroup;
        const startsSeparatedGroupInSameFile =
          startedAnyOnlyMatchingContextGroup &&
          firstLineNumber > lastOnlyMatchingContextGroupLineNumber + 1;
        if (
          groupSeparator !== undefined &&
          (startsAnotherFileGroup || startsSeparatedGroupInSameFile)
        ) {
          const reportedSeparator = colorizeOutput({
            value: groupSeparator,
            capability: "separator",
          });
          await bufferedStdout.write({ text: `${reportedSeparator}\n` });
        }
        startedAnyOnlyMatchingContextGroup = true;
        printedAnyOnlyMatchingContextGroup = true;
      };

      const rememberLine = ({
        contextLine,
      }: {
        contextLine: ContextLine;
      }): void => {
        previousLines.push({ value: contextLine });
      };

      const classifiedInput = await classifyGrepInputStream({
        stream,
        mode: binaryFilesMode,
        nullData,
      });
      if (classifiedInput.isBinary && binaryFilesMode === "without-match") {
        await classifiedInput.stream.cancel();
        if (!quiet) {
          switch (outputMode) {
          case "count": {
            const output = `${appendFilenamePrefix({ output: "", name, separator: ":" })}0\n`;
            await bufferedStdout.write({ text: output });
            break;
          }
          case "files-without-match":
            if (name !== undefined) {
              await writeFilenameOnly({ name });
            }
            break;
          case "lines":
          case "files-with-matches":
          case "only-matching":
            break;
          default: {
            const _ex: never = outputMode;
            throw new Error(`Unhandled output mode: ${_ex}`);
          }
          }
        }
        return {
          matched: false,
          selectedLineCount: 0,
        };
      }
      let isBinary = classifiedInput.isBinary;
      const recordChunks =
        binaryFilesMode === "binary" && !nullData
          ? classifiedInput.stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller): void {
                const firstNulIndex = chunk.indexOf(0x00);
                if (firstNulIndex === -1) {
                  controller.enqueue(chunk);
                  return;
                }

                isBinary = true;
                const normalizedChunk = chunk.slice();
                for (
                  let index = firstNulIndex;
                  index < normalizedChunk.byteLength;
                  index += 1
                ) {
                  if (normalizedChunk[index] === 0x00) {
                    normalizedChunk[index] = 0x0a;
                  }
                }
                controller.enqueue(normalizedChunk);
              },
            }),
          )
          : classifiedInput.stream;

      for await (const record of iterateUtf8RecordEntries({
        chunks: recordChunks,
        delimiterByte: inputRecordDelimiterByte,
        stripTrailingCarriageReturn: false,
        includeBytes: true,
      })) {
        const line = decodeCommandDataBytes({ bytes: record.bytes! });
        const byteOffset = lineByteOffset;
        lineByteOffset += record.byteLength;
        lineNumber += 1;
        if (!nullData && !isBinary && line.includes("\0")) {
          isBinary = true;
          switch (binaryFilesMode) {
          case "without-match":
            state.matched = false;
            state.selectedLineCount = 0;
            stop = true;
            break;
          case "binary":
          case "text":
            break;
          default:
            throw new Error(
              `Unhandled grep binary files mode: ${binaryFilesMode satisfies never}`,
            );
          }
        }
        if (stop) {
          break;
        }
        if (
          hasUnsafeBacktracking &&
          line.length > GREP_UNSAFE_BACKTRACKING_RECORD_LIMIT
        ) {
          await text.error({
            text: "grep: regular expression input exceeds the safe backtracking limit\n",
          });
          sawError = true;
          stop = true;
          break;
        }
        const matchLine = asciiCaseInsensitive
          ? foldAsciiCase({ value: line })
          : line;
        regex.lastIndex = 0;
        const regexMatched = regex.test(matchLine);
        const selected = invertMatch ? !regexMatched : regexMatched;
        const contextLine: ContextLine = {
          line,
          lineNumber,
          byteOffset,
          bytes: record.bytes,
          selected,
        };

        if (selected && state.selectedLineCount < maxCount) {
          state.matched = true;
          state.selectedLineCount += 1;

          if (quiet) {
            stop = true;
          } else if (
            isBinary &&
            binaryFilesMode === "binary" &&
            (outputMode === "lines" || outputMode === "only-matching")
          ) {
            await text.error({
              text: `grep: ${name ?? "(standard input)"}: binary file matches\n`,
            });
            stop = true;
          } else {
            switch (outputMode) {
            case "count":
            case "files-without-match":
              stop = state.selectedLineCount >= maxCount;
              break;
            case "files-with-matches":
              if (name !== undefined) {
                await writeFilenameOnly({ name });
              }
              stop = true;
              break;
            case "only-matching": {
              if (contextRequested) {
                const unreportedPreviousLines = previousLines.valuesAfter({
                  lineNumber: lastOnlyMatchingContextGroupLineNumber,
                });
                const firstPreviousLine = unreportedPreviousLines.next();
                const firstLineNumber = firstPreviousLine.done
                  ? lineNumber
                  : firstPreviousLine.value.lineNumber;
                await startOnlyMatchingContextGroup({ firstLineNumber });
                if (!firstPreviousLine.done) {
                  await writeOnlyMatchingLine({
                    contextLine: firstPreviousLine.value,
                    reportAsSelected: false,
                    name,
                    numericFieldWidth,
                  });
                  lastOnlyMatchingContextGroupLineNumber =
                      firstPreviousLine.value.lineNumber;
                }
                for (const previousLine of unreportedPreviousLines) {
                  await writeOnlyMatchingLine({
                    contextLine: previousLine,
                    reportAsSelected: false,
                    name,
                    numericFieldWidth,
                  });
                  lastOnlyMatchingContextGroupLineNumber =
                      previousLine.lineNumber;
                }
                await writeOnlyMatchingLine({
                  contextLine,
                  reportAsSelected: true,
                  name,
                  numericFieldWidth,
                });
                lastOnlyMatchingContextGroupLineNumber = lineNumber;
                remainingAfterLines = after;
                stop =
                    state.selectedLineCount >= maxCount &&
                    remainingAfterLines === 0;
              } else {
                await writeOnlyMatchingLine({
                  contextLine,
                  reportAsSelected: true,
                  name,
                  numericFieldWidth,
                });
                stop = state.selectedLineCount >= maxCount;
              }
              break;
            }
            case "lines": {
              const unprintedPreviousLines = previousLines.valuesAfter({
                lineNumber: lastPrintedLineNumber,
              });
              const firstPreviousLine = unprintedPreviousLines.next();
              const firstLineNumber = firstPreviousLine.done
                ? lineNumber
                : firstPreviousLine.value.lineNumber;
              await writeContextGroupSeparatorIfNeeded({ firstLineNumber });
              if (!firstPreviousLine.done) {
                await writeReportedLine({
                  ...firstPreviousLine.value,
                  name,
                  numericFieldWidth,
                });
                lastPrintedLineNumber = firstPreviousLine.value.lineNumber;
              }
              for (const previousLine of unprintedPreviousLines) {
                await writeReportedLine({
                  ...previousLine,
                  name,
                  numericFieldWidth,
                });
                lastPrintedLineNumber = previousLine.lineNumber;
              }
              if (lineNumber > lastPrintedLineNumber) {
                await writeReportedLine({
                  line,
                  bytes: record.bytes,
                  lineNumber,
                  byteOffset,
                  selected: true,
                  name,
                  numericFieldWidth,
                });
                lastPrintedLineNumber = lineNumber;
              }
              printedAnyGroup = true;
              printedAnyLineGroup = true;
              remainingAfterLines = after;
              stop =
                  state.selectedLineCount >= maxCount &&
                  remainingAfterLines === 0;
              break;
            }
            default: {
              const _ex: never = outputMode;
              throw new Error(`Unhandled output mode: ${_ex}`);
            }
            }
          }
        } else if (
          outputMode === "only-matching" &&
          contextRequested &&
          remainingAfterLines > 0
        ) {
          await writeOnlyMatchingLine({
            contextLine,
            reportAsSelected: false,
            name,
            numericFieldWidth,
          });
          lastOnlyMatchingContextGroupLineNumber = lineNumber;
          remainingAfterLines -= 1;
          if (
            state.selectedLineCount >= maxCount &&
            remainingAfterLines === 0
          ) {
            stop = true;
          }
        } else if (outputMode === "lines" && remainingAfterLines > 0) {
          if (lineNumber > lastPrintedLineNumber) {
            await writeReportedLine({
              line,
              bytes: record.bytes,
              lineNumber,
              byteOffset,
              selected: false,
              name,
              numericFieldWidth,
            });
            lastPrintedLineNumber = lineNumber;
          }
          printedAnyGroup = true;
          printedAnyLineGroup = true;
          remainingAfterLines -= 1;
          if (
            state.selectedLineCount >= maxCount &&
            remainingAfterLines === 0
          ) {
            stop = true;
          }
        } else if (selected && state.selectedLineCount >= maxCount) {
          stop = true;
        }

        rememberLine({ contextLine });
        if (stop) {
          break;
        }
      }

      if (!quiet) {
        switch (outputMode) {
        case "count": {
          let output = appendFilenamePrefix({
            output: "",
            name,
            separator: ":",
          });
          output += `${Math.min(state.selectedLineCount, maxCount)}\n`;
          await bufferedStdout.write({ text: output });
          break;
        }
        case "files-without-match":
          if (!state.matched && name !== undefined) {
            await writeFilenameOnly({ name });
          }
          break;
        case "lines":
        case "files-with-matches":
        case "only-matching":
          break;
        default: {
          const _ex: never = outputMode;
          throw new Error(`Unhandled output mode: ${_ex}`);
        }
        }
      }

      return {
        matched: state.matched,
        selectedLineCount: state.selectedLineCount,
      };
    };

    const searchFile = async ({
      entry,
      file,
      displayName,
    }: {
      entry?: WeshEntryRef;
      file: string;
      displayName: string;
    }): Promise<boolean> => {
      const stream = await openGrepInputStream({
        context,
        file,
        entry,
      });
      let numericFieldWidth = 1;
      if (initialTab && entry !== undefined) {
        switch (entry.type) {
        case "file":
          numericFieldWidth = Math.max(
            1,
            String((await context.files.statEntry({ entry })).size).length,
          );
          break;
        case "directory":
        case "fifo":
        case "chardev":
        case "symlink":
          numericFieldWidth = GREP_NON_SEEKABLE_OFFSET_WIDTH;
          break;
        default:
          throw new Error(
            `Unhandled grep input entry type: ${entry satisfies never}`,
          );
        }
      } else if (initialTab) {
        numericFieldWidth = GREP_NON_SEEKABLE_OFFSET_WIDTH;
      }
      const report = await processStream({
        stream,
        name: displayName,
        numericFieldWidth,
      });
      if (report.matched) {
        sawMatch = true;
      }
      return quiet && report.matched;
    };

    const activeDirectoryPaths = new Set<string>();

    const searchEntry = async ({
      entry,
      displayName,
      isCommandLineArgument,
    }: {
      entry: WeshEntryRef;
      displayName: string;
      isCommandLineArgument: boolean;
    }): Promise<boolean> => {
      switch (entry.type) {
      case "directory": {
        switch (directoryAction) {
        case "skip":
          return false;
        case "read":
          throw new Error("Is a directory");
        case "recurse":
          break;
        default: {
          const _ex: never = directoryAction;
          throw new Error(`Unhandled grep directory action: ${_ex}`);
        }
        }
        if (
          excludeDirPatterns.some((pattern) =>
            pattern.test(basename({ path: displayName })),
          )
        ) {
          return false;
        }
        if (activeDirectoryPaths.has(entry.fullPath)) {
          throw new Error("warning: recursive directory loop");
        }
        activeDirectoryPaths.add(entry.fullPath);
        try {
          for await (const child of context.files.readDirEntry({
            entry: asDirectoryEntryRef({ entry }),
          })) {
            const childDisplayName =
                displayName === "/"
                  ? `/${child.name}`
                  : `${displayName}/${child.name}`;
            if (
              child.type === "directory" &&
                excludeDirPatterns.some((pattern) => pattern.test(child.name))
            ) {
              continue;
            }
            if (
              child.type !== "directory" &&
                child.type !== "symlink" &&
                !shouldSearchFile({ displayPath: childDisplayName })
            ) {
              continue;
            }
            try {
              if (
                await searchEntry({
                  entry: child,
                  displayName: childDisplayName,
                  isCommandLineArgument: false,
                })
              ) {
                return true;
              }
            } catch (error: unknown) {
              await reportSearchError({
                displayName: childDisplayName,
                error,
              });
            }
          }
        } finally {
          activeDirectoryPaths.delete(entry.fullPath);
        }
        return false;
      }
      case "symlink": {
        if (!isCommandLineArgument && recursiveMode !== "logical") {
          return false;
        }
        const resolvedEntry = await context.files.resolveEntry({
          path: entry.fullPath,
          finalSymlinkTreatment: "follow",
        });
        return searchEntry({
          entry: resolvedEntry,
          displayName,
          isCommandLineArgument: false,
        });
      }
      case "file":
      case "fifo":
      case "chardev":
        if (entry.type !== "file" && deviceAction === "skip") {
          return false;
        }
        if (!shouldSearchFile({ displayPath: displayName })) {
          return false;
        }
        return searchFile({
          entry,
          file: entry.fullPath,
          displayName,
        });
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled entry type: ${_ex}`);
      }
      }
    };

    if (
      (maxCount === 0 || noSelectedRecordIsPossible) &&
      (outputMode !== "files-without-match" || quiet)
    ) {
      await bufferedStdout.flush();
      return { exitCode: 1 };
    }

    const directEntryRefs = new Map<string, {
      readonly refs: WeshEntryRef[];
      nextIndex: number;
    }>();
    for (let index = 0; index < context.args.length; index += 1) {
      const entryRef = context.getArgumentEntryRef({ index });
      if (entryRef === undefined) {
        continue;
      }
      const argument = context.args[index];
      if (argument === undefined) {
        continue;
      }
      const queue = directEntryRefs.get(argument) ?? {
        refs: [],
        nextIndex: 0,
      };
      queue.refs.push(entryRef);
      directEntryRefs.set(argument, queue);
    }

    const inputFiles = files.length === 0 ? ["-"] : files;
    const stdinLabel =
      typeof parsed.optionValues.label === "string"
        ? parsed.optionValues.label
        : "(standard input)";
    for (const file of inputFiles) {
      const displayName = file === "-" ? stdinLabel : file;
      try {
        const directRefQueue = directEntryRefs.get(file);
        const directEntryRef = directRefQueue?.refs[directRefQueue.nextIndex];
        if (directEntryRef !== undefined && directRefQueue !== undefined) {
          directRefQueue.nextIndex += 1;
        }
        const stop =
          file === "-"
            ? await searchFile({ file, displayName })
            : await searchEntry({
              entry: directEntryRef ??
                  (await context.files.resolveEntry({
                    path: resolvePath({ cwd: context.cwd, path: file }),
                    finalSymlinkTreatment: "follow",
                  })),
              displayName,
              isCommandLineArgument: true,
            });
        if (stop) {
          break;
        }
      } catch (error: unknown) {
        await reportSearchError({ displayName: file, error });
      }
    }

    await bufferedStdout.flush();

    if (quiet && sawMatch) {
      return { exitCode: 0 };
    }

    if (sawError) {
      return { exitCode: 2 };
    }

    return { exitCode: sawMatch ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
