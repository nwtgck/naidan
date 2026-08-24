import { parseFindLikeArgv } from '@/features/wesh/argv';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';
import { foldAsciiCase, resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import {
  compileBasicRegularExpression,
  compileEmacsRegularExpression,
  compileExtendedRegularExpression,
  translatePosixCharacterClasses,
} from '@/features/wesh/commands/_shared/posix-regexp';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  maybeWriteStandaloneCommandHelp,
  writeCommandUsageError,
} from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEntryRef,
  WeshFileType,
} from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

type FindRegexSyntax =
  | 'emacs'
  | 'basic'
  | 'minimal-basic'
  | 'extended-gnu'
  | 'extended-posix-awk'
  | 'extended-awk';
type FindNumericComparison = 'eq' | 'lt' | 'gt';
type FindLeadingSymlinkOption = '-P' | '-H' | '-L';

type FindExpression =
  | { kind: 'and', left: FindExpression, right: FindExpression }
  | { kind: 'or', left: FindExpression, right: FindExpression }
  | { kind: 'comma', left: FindExpression, right: FindExpression }
  | { kind: 'not', expr: FindExpression }
  | { kind: 'name', pattern: string, caseInsensitive: boolean, asciiCaseFold: boolean, compiledPattern: RegExp }
  | { kind: 'path', pattern: string, compiledPattern: RegExp }
  | { kind: 'linkName', pattern: string, caseInsensitive: boolean, asciiCaseFold: boolean, compiledPattern: RegExp }
  | { kind: 'regex', pattern: RegExp }
  | { kind: 'type', expected: readonly WeshFileType[] }
  | { kind: 'empty' }
  | { kind: 'size', comparison: FindNumericComparison, count: bigint, unitSize: number, roundUp: boolean }
  | { kind: 'age', comparison: FindNumericComparison, count: number, unitMilliseconds: number, rounding: 'ceilExact' | 'floorAll' }
  | { kind: 'perm', matchMode: 'exact' | 'all' | 'any', mode: number }
  | { kind: 'newer', referencePath: string, referenceMtime: number }
  | { kind: 'print' }
  | { kind: 'print0' }
  | { kind: 'prune' }
  | { kind: 'delete' }
  | { kind: 'quit' }
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'exec', id: number, mode: 'single' | 'batch', command: string, args: string[] };

interface FindEntry {
  entryRef: WeshEntryRef,
  fullPath: string,
  displayPath: string,
  type: WeshFileType,
  name: string,
  size: number,
  mode: number,
  mtime: number,
}

interface FindEvaluationResult {
  matched: boolean,
  actionInvoked: boolean,
  shouldPrune: boolean,
  shouldQuit: boolean,
  exitCode: number,
}

const EVAL_MATCHED: FindEvaluationResult = { matched: true, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
const EVAL_NOT_MATCHED: FindEvaluationResult = { matched: false, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };

interface PendingExecBatchEntry {
  path: string,
  entryRef: WeshEntryRef,
}

interface PendingExecBatch {
  id: number,
  command: string,
  argsTemplate: string[],
  entries: PendingExecBatchEntry[],
  argumentBytes: number,
}

interface ExecInvocation {
  args: string[],
  argumentEntryRefs: Array<WeshEntryRef | undefined>,
}

type FindOutputWriter = ReturnType<typeof createBufferedTextWriter>;

const MAX_EXEC_BATCH_PATH_COUNT = 512;
const MAX_EXEC_BATCH_ARGUMENT_BYTES = 128 * 1024;
const utf8Encoder = new TextEncoder();

interface FindTraversalOptions {
  maxDepth: number | undefined,
  minDepth: number,
  depthFirst: boolean,
  symlinkMode: 'physical' | 'command-line' | 'logical',
}

function canEvaluateWithoutFullStat({
  expr,
}: {
  expr: FindExpression,
}): boolean {
  const pending: FindExpression[] = [expr];
  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
    case 'and':
    case 'or':
    case 'comma':
      pending.push(current.right, current.left);
      break;
    case 'not':
      pending.push(current.expr);
      break;
    case 'name':
    case 'path':
    case 'linkName':
    case 'regex':
    case 'type':
    case 'print':
    case 'print0':
    case 'prune':
    case 'delete':
    case 'quit':
    case 'true':
    case 'false':
    case 'exec':
      break;
    case 'empty':
    case 'size':
    case 'age':
    case 'perm':
    case 'newer':
      return false;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled find expression: ${_ex}`);
    }
    }
  }
  return true;
}

const findHelpArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'L', long: undefined, effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'follow symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'P', long: undefined, effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'never follow symbolic links', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'output version information and exit', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function basename({ path }: { path: string }): string {
  if (path === '/') return '/';
  const end = path.endsWith('/') ? path.length - 1 : path.length;
  const separatorIndex = path.lastIndexOf('/', end - 1);
  return path.slice(separatorIndex + 1, end);
}

function consumeGlobCharacterClass({
  pattern,
  startIndex,
}: {
  pattern: string,
  startIndex: number,
}): { source: string, endIndex: number } | undefined {
  let index = startIndex + 1;
  if (pattern[index] === '!' || pattern[index] === '^') index += 1;
  if (pattern[index] === ']') index += 1;

  while (index < pattern.length) {
    const marker = pattern[index + 1];
    if (pattern[index] === '[' && (marker === ':' || marker === '.' || marker === '=')) {
      const closing = `${marker}]`;
      const subexpressionEnd = pattern.indexOf(closing, index + 2);
      if (subexpressionEnd >= 0) {
        index = subexpressionEnd + 2;
        continue;
      }
    }
    if (pattern[index] === '\\' && index + 1 < pattern.length) {
      index += 2;
      continue;
    }
    if (pattern[index] === ']') {
      const raw = pattern.slice(startIndex, index + 1);
      return {
        source: raw.startsWith('[!') ? `[^${raw.slice(2)}` : raw,
        endIndex: index,
      };
    }
    index += 1;
  }

  return undefined;
}

function globToRegExp({
  pattern,
  caseInsensitive,
  characterLocaleMode,
}: {
  pattern: string,
  caseInsensitive: boolean,
  characterLocaleMode: WeshCharacterLocaleMode,
}): RegExp {
  const normalizedPattern = caseInsensitive && characterLocaleMode === 'ascii'
    ? foldAsciiCase({ value: pattern })
    : pattern;
  let source = '^';

  for (let index = 0; index < normalizedPattern.length; index++) {
    const char = normalizedPattern[index];
    if (char === undefined) continue;

    switch (char) {
    case '*':
      source += '.*';
      break;
    case '?':
      source += '.';
      break;
    case '[': {
      const characterClass = consumeGlobCharacterClass({
        pattern: normalizedPattern,
        startIndex: index,
      });
      if (characterClass === undefined) {
        source += '\\[';
      } else {
        source += characterClass.source;
        index = characterClass.endIndex;
      }
      break;
    }
    case '\\': {
      const next = normalizedPattern[index + 1];
      if (next === undefined) {
        source += '\\\\';
      } else {
        source += next.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        index += 1;
      }
      break;
    }
    default:
      source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      break;
    }
  }

  source += '$';
  const translated = translatePosixCharacterClasses({
    source,
    characterClassMode: characterLocaleMode,
  });
  const nativeCaseInsensitive = caseInsensitive && characterLocaleMode === 'unicode';
  const flags = `${nativeCaseInsensitive ? 'i' : ''}${translated.requiresUnicode ? 'u' : ''}`;
  return new RegExp(translated.source, flags || undefined);
}

function parseNonNegativeInteger({
  value,
  optionName,
}: {
  value: string,
  optionName: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `invalid argument to ${optionName}: ${value}` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function parseFindRegexType({
  value,
}: {
  value: string,
}): { ok: true, value: FindRegexSyntax } | { ok: false, message: string } {
  switch (value) {
  case 'findutils-default':
  case 'emacs':
    return { ok: true, value: 'emacs' };
  case 'posix-minimal-basic':
    return { ok: true, value: 'minimal-basic' };
  case 'ed':
  case 'grep':
  case 'posix-basic':
  case 'sed':
    return { ok: true, value: 'basic' };
  case 'awk':
    return { ok: true, value: 'extended-awk' };
  case 'posix-awk':
    return { ok: true, value: 'extended-posix-awk' };
  case 'egrep':
  case 'gnu-awk':
  case 'posix-egrep':
  case 'posix-extended':
    return { ok: true, value: 'extended-gnu' };
  default:
    return { ok: false, message: `unknown regular expression type '${value}'` };
  }
}

function escapeFindRegexLiteralCharacter({ character }: { character: string }): string {
  return `[${character.replace(/[\\\]^-]/gu, '\\$&')}]`;
}

function normalizeFindExtendedRegexSource({
  source,
  flavor,
}: {
  source: string,
  flavor: 'gnu' | 'posix-awk' | 'awk',
}): string {
  switch (flavor) {
  case 'gnu':
    return source;
  case 'posix-awk':
  case 'awk':
    break;
  default: {
    const _ex: never = flavor;
    throw new Error(`Unhandled find regular expression flavor: ${_ex}`);
  }
  }

  let result = '';
  let inBracketExpression = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '[' && !inBracketExpression) {
      inBracketExpression = true;
      result += character;
      continue;
    }
    if (character === ']' && inBracketExpression) {
      inBracketExpression = false;
      result += character;
      continue;
    }
    if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        result += character;
        continue;
      }
      if (
        !inBracketExpression
        && (
          /[A-Za-z]/.test(escaped)
          || (flavor === 'awk' && /[1-9]/.test(escaped))
        )
      ) {
        result += escapeFindRegexLiteralCharacter({ character: escaped });
      } else {
        result += `${character}${escaped}`;
      }
      index += 1;
      continue;
    }
    if (!inBracketExpression && flavor === 'awk' && (character === '{' || character === '}')) {
      result += escapeFindRegexLiteralCharacter({ character });
      continue;
    }
    result += character;
  }
  return result;
}

function anchorFindRegex({
  regex,
}: {
  regex: RegExp,
}): RegExp {
  return new RegExp(`^(?:${regex.source})$`, regex.flags || undefined);
}

function oppositeAsciiCase({ character }: { character: string }): string | undefined {
  if (character >= 'A' && character <= 'Z') return character.toLowerCase();
  if (character >= 'a' && character <= 'z') return character.toUpperCase();
  return undefined;
}

function consumeRegExpEscape({
  source,
  startIndex,
}: {
  source: string,
  startIndex: number,
}): { text: string, endIndex: number } {
  const escaped = source[startIndex + 1];
  if (escaped === undefined) return { text: '\\', endIndex: startIndex };

  if ((escaped === 'p' || escaped === 'P' || escaped === 'u') && source[startIndex + 2] === '{') {
    const closeIndex = source.indexOf('}', startIndex + 3);
    if (closeIndex !== -1) {
      return {
        text: source.slice(startIndex, closeIndex + 1),
        endIndex: closeIndex,
      };
    }
  }

  const fixedHexLength = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 0;
  if (fixedHexLength > 0) {
    const endIndex = startIndex + 1 + fixedHexLength;
    const digits = source.slice(startIndex + 2, endIndex + 1);
    if (digits.length === fixedHexLength && /^[0-9A-Fa-f]+$/u.test(digits)) {
      const character = String.fromCodePoint(Number.parseInt(digits, 16));
      const opposite = oppositeAsciiCase({ character });
      if (opposite !== undefined) {
        return {
          text: `[${character}${opposite}]`,
          endIndex,
        };
      }
      return {
        text: source.slice(startIndex, endIndex + 1),
        endIndex,
      };
    }
  }

  return {
    text: source.slice(startIndex, startIndex + 2),
    endIndex: startIndex + 1,
  };
}

function consumeRegExpBracket({
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
    if (source[index] === '\\') {
      const escaped = consumeRegExpEscape({ source, startIndex: index });
      index = escaped.endIndex + 1;
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

function normalizeAsciiCaseInsensitiveRange({
  start,
  end,
}: {
  start: string,
  end: string,
}): string | undefined {
  const foldedStart = foldAsciiCase({ value: start });
  const foldedEnd = foldAsciiCase({ value: end });
  if (
    foldedStart.length !== 1
    || foldedEnd.length !== 1
    || foldedStart < 'a'
    || foldedStart > 'z'
    || foldedEnd < 'a'
    || foldedEnd > 'z'
  ) {
    return undefined;
  }
  if (foldedStart > foldedEnd) return '';

  const upperStart = foldedStart.toUpperCase();
  const upperEnd = foldedEnd.toUpperCase();
  if (foldedStart === foldedEnd) return `${foldedStart}${upperStart}`;
  return `${foldedStart}-${foldedEnd}${upperStart}-${upperEnd}`;
}

function expandAsciiCaseInBracket({ source }: { source: string }): string {
  const prefix = source.startsWith('[^') ? '[^' : '[';
  const contentStart = prefix.length;
  const contentEnd = source.length - 1;
  let result = prefix;

  for (let index = contentStart; index < contentEnd; index++) {
    const character = source[index]!;
    if (character === '\\') {
      const escaped = consumeRegExpEscape({ source, startIndex: index });
      result += source.slice(index, escaped.endIndex + 1);
      index = escaped.endIndex;
      continue;
    }

    if (source[index + 1] === '-' && index + 2 < contentEnd) {
      const rangeEnd = source[index + 2]!;
      const normalizedRange = normalizeAsciiCaseInsensitiveRange({
        start: character,
        end: rangeEnd,
      });
      result += normalizedRange ?? `${character}-${rangeEnd}`;
      index += 2;
      continue;
    }

    const opposite = oppositeAsciiCase({ character });
    result += opposite === undefined ? character : `${character}${opposite}`;
  }

  return `${result}]`;
}

function expandAsciiCaseInRegExpSource({ source }: { source: string }): string {
  let result = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '\\') {
      const escaped = consumeRegExpEscape({ source, startIndex: index });
      result += escaped.text;
      index = escaped.endIndex;
      continue;
    }
    if (character === '[') {
      const bracket = consumeRegExpBracket({ source, startIndex: index });
      if (bracket !== undefined) {
        result += expandAsciiCaseInBracket({ source: bracket.source });
        index = bracket.endIndex;
        continue;
      }
    }
    const opposite = oppositeAsciiCase({ character });
    result += opposite === undefined ? character : `[${character}${opposite}]`;
  }
  return result;
}

function makeAsciiCaseInsensitiveRegExp({ regexp }: { regexp: RegExp }): RegExp {
  return new RegExp(
    expandAsciiCaseInRegExpSource({ source: regexp.source }),
    regexp.flags.replace(/i/gu, ''),
  );
}

function parseFindRegex({
  value,
  caseInsensitive,
  syntax,
  characterLocaleMode,
}: {
  value: string,
  caseInsensitive: boolean,
  syntax: FindRegexSyntax,
  characterLocaleMode: WeshCharacterLocaleMode,
}): { ok: true, value: RegExp } | { ok: false, message: string } {
  try {
    const nativeCaseInsensitive = caseInsensitive && characterLocaleMode === 'unicode';
    const flags = nativeCaseInsensitive ? 'i' : '';
    const regex = (() => {
      switch (syntax) {
      case 'emacs':
        return compileEmacsRegularExpression({
          source: value,
          flags,
          matchWholeString: true,
        });
      case 'basic':
        return anchorFindRegex({
          regex: compileBasicRegularExpression({
            source: value,
            flags,
            characterClassMode: characterLocaleMode,
            gnuWordOperators: true,
            basicOperatorMode: 'gnu',
            dotMode: 'javascript',
            excludeSurrogateEscapes: false,
          }),
        });
      case 'minimal-basic':
        return anchorFindRegex({
          regex: compileBasicRegularExpression({
            source: value,
            flags,
            characterClassMode: characterLocaleMode,
            gnuWordOperators: true,
            basicOperatorMode: 'minimal',
            dotMode: 'javascript',
            excludeSurrogateEscapes: false,
          }),
        });
      case 'extended-gnu':
      case 'extended-posix-awk':
      case 'extended-awk': {
        const flavor = (() => {
          switch (syntax) {
          case 'extended-gnu':
            return 'gnu' as const;
          case 'extended-posix-awk':
            return 'posix-awk' as const;
          case 'extended-awk':
            return 'awk' as const;
          default: {
            const _ex: never = syntax;
            throw new Error(`Unhandled find extended regular expression syntax: ${_ex}`);
          }
          }
        })();
        return anchorFindRegex({
          regex: compileExtendedRegularExpression({
            source: normalizeFindExtendedRegexSource({ source: value, flavor }),
            flags,
            characterClassMode: characterLocaleMode,
            dotMode: 'javascript',
            excludeSurrogateEscapes: false,
            gnuWordOperators: (() => {
              switch (flavor) {
              case 'gnu':
                return true;
              case 'posix-awk':
              case 'awk':
                return false;
              default: {
                const _ex: never = flavor;
                throw new Error(`Unhandled find regular expression flavor: ${_ex}`);
              }
              }
            })(),
          }),
        });
      }
      default: {
        const _ex: never = syntax;
        throw new Error(`Unhandled find regular expression syntax: ${_ex}`);
      }
      }
    })();
    return {
      ok: true,
      value: caseInsensitive && characterLocaleMode === 'ascii'
        ? makeAsciiCaseInsensitiveRegExp({ regexp: regex })
        : regex,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression '${value}': ${message}` };
  }
}

function parseFindSize({
  value,
}: {
  value: string,
}): {
  ok: true,
  comparison: 'eq' | 'lt' | 'gt',
  count: bigint,
  unitSize: number,
  roundUp: boolean,
} | { ok: false, message: string } {
  const match = value.match(/^([+-]?)(\d+)([bcwkMGT]?)$/);
  if (match === null) {
    return { ok: false, message: `invalid argument to -size: ${value}` };
  }

  const prefix = match[1] ?? '';
  const count = BigInt(match[2] ?? '0');
  if (count > 0xffff_ffff_ffff_ffffn) {
    return { ok: false, message: `invalid argument to -size: ${value}` };
  }
  const unit = match[3] ?? '';
  const { unitSize, roundUp } = (() => {
    switch (unit) {
    case 'c':
      return { unitSize: 1, roundUp: false };
    case 'w':
      return { unitSize: 2, roundUp: true };
    case '':
    case 'b':
      return { unitSize: 512, roundUp: true };
    case 'k':
      return { unitSize: 1024, roundUp: true };
    case 'M':
      return { unitSize: 1024 * 1024, roundUp: true };
    case 'G':
      return { unitSize: 1024 * 1024 * 1024, roundUp: true };
    case 'T':
      return { unitSize: 1024 * 1024 * 1024 * 1024, roundUp: true };
    default:
      throw new Error(`Unhandled find size unit: ${unit}`);
    }
  })();

  return {
    ok: true,
    comparison: prefix === '+' ? 'gt' : prefix === '-' ? 'lt' : 'eq',
    count,
    unitSize,
    roundUp,
  };
}

function parseFindAgeNumber({
  value,
}: {
  value: string,
}): number | undefined {
  const lower = value.toLowerCase();
  if (lower === 'inf' || lower === 'infinity') return Number.POSITIVE_INFINITY;

  const hexadecimal = value.match(/^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/);
  if (hexadecimal !== null) {
    const wholeDigits = hexadecimal[1] ?? '';
    const fractionalDigits = hexadecimal[2] ?? '';
    if (wholeDigits.length === 0 && fractionalDigits.length === 0) return undefined;
    let significand = wholeDigits.length === 0 ? 0 : Number.parseInt(wholeDigits, 16);
    for (let index = 0; index < fractionalDigits.length; index += 1) {
      const digit = Number.parseInt(fractionalDigits[index]!, 16);
      significand += digit / (16 ** (index + 1));
    }
    const exponent = Number.parseInt(hexadecimal[3] ?? '0', 10);
    const result = significand * (2 ** exponent);
    return Number.isFinite(result) ? result : undefined;
  }

  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function parseFindAge({
  value,
  optionName,
  unitMilliseconds,
  rounding,
}: {
  value: string,
  optionName: '-mmin' | '-mtime',
  unitMilliseconds: number,
  rounding: 'ceilExact' | 'floorAll',
}): {
  ok: true,
  comparison: FindNumericComparison,
  count: number,
  unitMilliseconds: number,
  rounding: 'ceilExact' | 'floorAll',
} | { ok: false, message: string } {
  const match = value.match(/^([+-]?)(.+)$/);
  if (match === null) {
    return { ok: false, message: `invalid argument to ${optionName}: ${value}` };
  }
  const prefix = match[1] ?? '';
  const count = parseFindAgeNumber({ value: match[2] ?? '' });
  if (count === undefined) {
    return { ok: false, message: `invalid argument to ${optionName}: ${value}` };
  }
  return {
    ok: true,
    comparison: prefix === '+' ? 'gt' : prefix === '-' ? 'lt' : 'eq',
    count,
    unitMilliseconds,
    rounding,
  };
}

function parseFindPerm({
  value,
}: {
  value: string,
}): { ok: true, matchMode: 'exact' | 'all' | 'any', mode: number } | { ok: false, message: string } {
  const prefix: '' | '-' | '/' = value[0] === '-' || value[0] === '/' ? value[0] : '';
  const modeValue = prefix.length === 0 ? value : value.slice(1);
  const parsed = parseFilePermissionMode({
    value: modeValue,
    initialMode: 0,
    umask: 0,
    allowSpecialBits: true,
  });
  if (!parsed.ok) {
    return { ok: false, message: `invalid argument to -perm: ${value}` };
  }

  const matchMode = (() => {
    switch (prefix) {
    case '': return 'exact' as const;
    case '-': return 'all' as const;
    case '/': return 'any' as const;
    default: {
      const _ex: never = prefix;
      throw new Error(`Unhandled find permission prefix: ${_ex}`);
    }
    }
  })();

  return {
    ok: true,
    matchMode,
    mode: parsed.mode,
  };
}

function splitFindLeadingOptions({
  args,
}: {
  args: string[],
}): {
  leadingOptions: FindLeadingSymlinkOption[],
  remainingArgs: string[],
} {
  const leadingOptions: FindLeadingSymlinkOption[] = [];
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token !== '-H' && token !== '-L' && token !== '-P') {
      break;
    }
    leadingOptions.push(token);
    index += 1;
  }

  return {
    leadingOptions,
    remainingArgs: args.slice(index),
  };
}

function findEarlyExitRequest({
  args,
  characterLocaleMode,
}: {
  args: readonly string[],
  characterLocaleMode: WeshCharacterLocaleMode,
}): 'help' | 'version' | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token !== '--help' && token !== '--version') continue;

    const prefix = splitFindLeadingOptions({ args: args.slice(0, index) });
    const parsedPrefix = parseFindLikeArgv({ args: prefix.remainingArgs });
    const expressionPrefix = tokenizeFindExpression({
      tokens: parsedPrefix.expressionTokens,
      characterLocaleMode,
      symlinkMode: resolveFindLeadingSymlinkMode({ leadingOptions: prefix.leadingOptions }),
    });
    if (!expressionPrefix.ok) continue;

    switch (token) {
    case '--help':
      return 'help';
    case '--version':
      return 'version';
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled find early-exit token: ${_ex}`);
    }
    }
  }
  return undefined;
}

function resolveFindLeadingSymlinkMode({
  leadingOptions,
}: {
  leadingOptions: readonly FindLeadingSymlinkOption[],
}): FindTraversalOptions['symlinkMode'] {
  let symlinkMode: FindTraversalOptions['symlinkMode'] = 'physical';
  for (const option of leadingOptions) {
    switch (option) {
    case '-P':
      symlinkMode = 'physical';
      break;
    case '-H':
      symlinkMode = 'command-line';
      break;
    case '-L':
      symlinkMode = 'logical';
      break;
    default: {
      const _ex: never = option;
      throw new Error(`Unhandled find leading option: ${_ex}`);
    }
    }
  }
  return symlinkMode;
}

function parseFindTypes({
  value,
}: {
  value: string,
}): {
  ok: true,
  expected: readonly WeshFileType[],
} | {
  ok: false,
  message: string,
} {
  if (value.length === 0) {
    return { ok: false, message: 'Arguments to -type should contain at least one letter' };
  }
  if (value.endsWith(',')) {
    return {
      ok: false,
      message: "Last file type in list argument to -type is missing, i.e., list is ending on: ','",
    };
  }

  const expected: WeshFileType[] = [];
  const seen = new Set<string>();
  for (const listItem of value.split(',')) {
    if (listItem.length === 0) {
      return { ok: false, message: 'Unknown argument to -type: ,' };
    }

    const typeTokens = Array.from(listItem);
    const typeToken = typeTokens[0];
    if (typeToken === undefined) {
      return { ok: false, message: 'Unknown argument to -type: ,' };
    }

    const expectedType = (() => {
      switch (typeToken) {
      case 'f':
        return 'file' as const;
      case 'd':
        return 'directory' as const;
      case 'p':
        return 'fifo' as const;
      case 'c':
        return 'chardev' as const;
      case 'l':
        return 'symlink' as const;
      default:
        return undefined;
      }
    })();
    if (expectedType === undefined) {
      return { ok: false, message: `Unknown argument to -type: ${typeToken}` };
    }
    if (typeTokens.length !== 1) {
      return { ok: false, message: "Must separate multiple arguments to -type using: ','" };
    }
    if (seen.has(typeToken)) {
      return {
        ok: false,
        message: `Duplicate file type '${typeToken}' in the argument list to -type.`,
      };
    }

    seen.add(typeToken);
    expected.push(expectedType);
  }

  return { ok: true, expected };
}

function tokenizeFindExpression({
  tokens,
  characterLocaleMode,
  symlinkMode,
}: {
  tokens: string[],
  characterLocaleMode: WeshCharacterLocaleMode,
  symlinkMode: FindTraversalOptions['symlinkMode'],
}): {
  ok: true,
  traversal: FindTraversalOptions,
  expr: FindExpression,
  hasAction: boolean,
} | {
  ok: false,
  message: string,
} {
  let index = 0;
  let nextExecId = 1;
  const expressionTokens: string[] = [];
  const traversal: FindTraversalOptions = {
    maxDepth: undefined,
    minDepth: 0,
    depthFirst: false,
    symlinkMode,
  };
  let regexSyntax: FindRegexSyntax = 'emacs';

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;

    if (token === '-maxdepth' || token === '-mindepth') {
      const valueToken = tokens[index + 1];
      if (valueToken === undefined) {
        return { ok: false, message: `missing argument to '${token}'` };
      }

      const parsed = parseNonNegativeInteger({ value: valueToken, optionName: token });
      if (!parsed.ok) return parsed;

      switch (token) {
      case '-maxdepth':
        traversal.maxDepth = parsed.value;
        break;
      case '-mindepth':
        traversal.minDepth = parsed.value;
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled traversal token: ${_ex}`);
      }
      }

      index += 2;
      continue;
    }

    if (token === '-depth') {
      traversal.depthFirst = true;
      index += 1;
      continue;
    }

    expressionTokens.push(token);
    index += 1;
  }

  index = 0;

  function peek(): string | undefined {
    return expressionTokens[index];
  }

  function next(): string | undefined {
    const token = expressionTokens[index];
    if (token !== undefined) index += 1;
    return token;
  }

  function canStartPrimary({ token }: { token: string | undefined }): boolean {
    return token !== undefined && [
      '(',
      '!',
      '-not',
      '-name',
      '-iname',
      '-path',
      '-lname',
      '-ilname',
      '-regex',
      '-iregex',
      '-regextype',
      '-type',
      '-empty',
      '-size',
      '-mmin',
      '-mtime',
      '-perm',
      '-newer',
      '-print',
      '-print0',
      '-prune',
      '-delete',
      '-quit',
      '-true',
      '-false',
      '-exec',
    ].includes(token);
  }

  function containsAction({ expr }: { expr: FindExpression }): boolean {
    const pending: FindExpression[] = [expr];
    while (pending.length > 0) {
      const current = pending.pop()!;
      switch (current.kind) {
      case 'and':
      case 'or':
      case 'comma':
        pending.push(current.right, current.left);
        break;
      case 'not':
        pending.push(current.expr);
        break;
      case 'print':
      case 'print0':
      case 'prune':
      case 'delete':
      case 'quit':
      case 'exec':
        return true;
      case 'name':
      case 'path':
      case 'linkName':
      case 'regex':
      case 'type':
      case 'empty':
      case 'size':
      case 'age':
      case 'perm':
      case 'newer':
      case 'true':
      case 'false':
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled find expression: ${_ex}`);
      }
      }
    }
    return false;
  }

  type FindExpressionOperator =
    | { kind: 'binary', operator: 'and' | 'or' | 'comma' }
    | { kind: 'not' }
    | { kind: 'open-group' };

  function binaryOperatorPrecedence({
    operator,
  }: {
    operator: 'and' | 'or' | 'comma',
  }): number {
    switch (operator) {
    case 'and':
      return 3;
    case 'or':
      return 2;
    case 'comma':
      return 1;
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled find expression operator: ${_ex}`);
    }
    }
  }

  function parseExpression(): FindExpression | string {
    const expressions: FindExpression[] = [];
    const operators: FindExpressionOperator[] = [];
    let openGroupCount = 0;
    let expectOperand = true;

    const reduceTopOperator = (): void => {
      const operator = operators.pop();
      if (operator === undefined) {
        throw new Error('find expression operator stack is empty');
      }
      switch (operator.kind) {
      case 'binary': {
        const right = expressions.pop();
        const left = expressions.pop();
        if (left === undefined || right === undefined) {
          throw new Error('find expression value stack is incomplete');
        }
        expressions.push({ kind: operator.operator, left, right });
        break;
      }
      case 'not': {
        const expr = expressions.pop();
        if (expr === undefined) {
          throw new Error('find expression value stack is incomplete');
        }
        expressions.push({ kind: 'not', expr });
        break;
      }
      case 'open-group':
        throw new Error('find expression group marker cannot be reduced');
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled find expression operator: ${JSON.stringify(_ex)}`);
      }
      }
    };

    const reducePendingNegations = (): void => {
      while (operators.at(-1)?.kind === 'not') {
        reduceTopOperator();
      }
    };

    const pushBinaryOperator = ({
      operator,
    }: {
      operator: 'and' | 'or' | 'comma',
    }): void => {
      const precedence = binaryOperatorPrecedence({ operator });
      while (true) {
        const current = operators.at(-1);
        if (current === undefined) break;
        switch (current.kind) {
        case 'binary':
          if (binaryOperatorPrecedence({ operator: current.operator }) >= precedence) {
            reduceTopOperator();
            continue;
          }
          break;
        case 'not':
        case 'open-group':
          break;
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled find expression operator: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      operators.push({ kind: 'binary', operator });
    };

    while (index < expressionTokens.length) {
      if (expectOperand) {
        while (peek() === '!' || peek() === '-not') {
          next();
          operators.push({ kind: 'not' });
        }

        const token = peek();
        if (token === undefined) return 'missing expression';
        if (token === '(') {
          next();
          operators.push({ kind: 'open-group' });
          openGroupCount += 1;
          continue;
        }

        const expr = parsePrimaryLeaf();
        if (typeof expr === 'string') return expr;
        expressions.push(expr);
        reducePendingNegations();
        expectOperand = false;
        continue;
      }

      const token = peek();
      if (token === ')') {
        if (openGroupCount === 0) break;
        while (operators.at(-1)?.kind !== 'open-group') {
          reduceTopOperator();
        }
        const marker = operators.pop();
        if (marker === undefined) {
          throw new Error('find expression group marker is missing');
        }
        switch (marker.kind) {
        case 'open-group':
          break;
        case 'binary':
        case 'not':
          throw new Error('find expression group marker is missing');
        default: {
          const _ex: never = marker;
          throw new Error(`Unhandled find expression operator: ${JSON.stringify(_ex)}`);
        }
        }
        openGroupCount -= 1;
        next();
        reducePendingNegations();
        continue;
      }

      const operator = (() => {
        switch (token) {
        case ',':
          next();
          return 'comma' as const;
        case '-o':
        case '-or':
          next();
          return 'or' as const;
        case '-a':
        case '-and':
          next();
          return 'and' as const;
        default:
          return canStartPrimary({ token }) ? 'and' as const : undefined;
        }
      })();
      if (operator === undefined) break;

      pushBinaryOperator({ operator });
      expectOperand = true;
    }

    if (expectOperand) return 'missing expression';
    if (openGroupCount > 0) return "expected ')'";
    while (operators.length > 0) {
      reduceTopOperator();
    }
    if (expressions.length !== 1) {
      throw new Error(`find expression parser produced ${expressions.length} values`);
    }
    return expressions[0]!;
  }

  function parsePrimaryLeaf(): FindExpression | string {
    const token = next();
    if (token === undefined) return 'missing expression';

    switch (token) {
    case '-name': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-name'";
      return {
        kind: 'name',
        pattern,
        caseInsensitive: false,
        asciiCaseFold: false,
        compiledPattern: globToRegExp({ pattern, caseInsensitive: false, characterLocaleMode }),
      };
    }
    case '-iname': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-iname'";
      return {
        kind: 'name',
        pattern,
        caseInsensitive: true,
        asciiCaseFold: characterLocaleMode === 'ascii',
        compiledPattern: globToRegExp({ pattern, caseInsensitive: true, characterLocaleMode }),
      };
    }
    case '-path': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-path'";
      return {
        kind: 'path',
        pattern,
        compiledPattern: globToRegExp({ pattern, caseInsensitive: false, characterLocaleMode }),
      };
    }
    case '-lname':
    case '-ilname': {
      const pattern = next();
      if (pattern === undefined) return `missing argument to '${token}'`;
      const caseInsensitive = token === '-ilname';
      return {
        kind: 'linkName',
        pattern,
        caseInsensitive,
        asciiCaseFold: caseInsensitive && characterLocaleMode === 'ascii',
        compiledPattern: globToRegExp({ pattern, caseInsensitive, characterLocaleMode }),
      };
    }
    case '-regex': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-regex'";
      const parsed = parseFindRegex({
        value: pattern,
        caseInsensitive: false,
        syntax: regexSyntax,
        characterLocaleMode,
      });
      if (!parsed.ok) return parsed.message;
      return { kind: 'regex', pattern: parsed.value };
    }
    case '-iregex': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-iregex'";
      const parsed = parseFindRegex({
        value: pattern,
        caseInsensitive: true,
        syntax: regexSyntax,
        characterLocaleMode,
      });
      if (!parsed.ok) return parsed.message;
      return { kind: 'regex', pattern: parsed.value };
    }
    case '-regextype': {
      const typeToken = next();
      if (typeToken === undefined) return "missing argument to '-regextype'";
      const parsed = parseFindRegexType({ value: typeToken });
      if (!parsed.ok) return parsed.message;
      regexSyntax = parsed.value;
      return { kind: 'true' };
    }
    case '-type': {
      const typeToken = next();
      if (typeToken === undefined) return "missing argument to '-type'";
      const parsed = parseFindTypes({ value: typeToken });
      if (!parsed.ok) return parsed.message;
      return { kind: 'type', expected: parsed.expected };
    }
    case '-empty':
      return { kind: 'empty' };
    case '-size': {
      const sizeToken = next();
      if (sizeToken === undefined) return "missing argument to '-size'";
      const parsed = parseFindSize({ value: sizeToken });
      if (!parsed.ok) return parsed.message;
      return {
        kind: 'size',
        comparison: parsed.comparison,
        count: parsed.count,
        unitSize: parsed.unitSize,
        roundUp: parsed.roundUp,
      };
    }
    case '-mmin':
    case '-mtime': {
      const value = next();
      if (value === undefined) return `missing argument to '${token}'`;
      const ageOptions = (() => {
        switch (token) {
        case '-mmin':
          return { unitMilliseconds: 60 * 1000, rounding: 'ceilExact' as const };
        case '-mtime':
          return { unitMilliseconds: 24 * 60 * 60 * 1000, rounding: 'floorAll' as const };
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled find age option: ${_ex}`);
        }
        }
      })();
      const parsed = parseFindAge({
        value,
        optionName: token,
        ...ageOptions,
      });
      if (!parsed.ok) return parsed.message;
      return {
        kind: 'age',
        comparison: parsed.comparison,
        count: parsed.count,
        unitMilliseconds: parsed.unitMilliseconds,
        rounding: parsed.rounding,
      };
    }
    case '-perm': {
      const permToken = next();
      if (permToken === undefined) return "missing argument to '-perm'";
      const parsed = parseFindPerm({ value: permToken });
      if (!parsed.ok) return parsed.message;
      return { kind: 'perm', matchMode: parsed.matchMode, mode: parsed.mode };
    }
    case '-newer': {
      const referencePath = next();
      if (referencePath === undefined) return "missing argument to '-newer'";
      return {
        kind: 'newer',
        referencePath,
        referenceMtime: Number.NaN,
      };
    }
    case '-print':
      return { kind: 'print' };
    case '-print0':
      return { kind: 'print0' };
    case '-prune':
      return { kind: 'prune' };
    case '-delete':
      return { kind: 'delete' };
    case '-quit':
      return { kind: 'quit' };
    case '-true':
      return { kind: 'true' };
    case '-false':
      return { kind: 'false' };
    case '-exec': {
      const argv: string[] = [];
      let mode: 'single' | 'batch' | undefined;

      while (true) {
        const arg = next();
        if (arg === undefined) return "missing terminating ';' for -exec";
        if (arg === ';' || arg === '+') {
          switch (arg) {
          case ';':
            mode = 'single';
            break;
          case '+':
            mode = 'batch';
            break;
          default: {
            const _ex: never = arg;
            throw new Error(`Unhandled -exec terminator: ${_ex}`);
          }
          }
          break;
        }
        argv.push(arg);
      }

      if (argv.length === 0) return 'missing command for -exec';
      const command = argv[0];
      if (command === undefined) return 'missing command for -exec';
      if (mode === undefined) return "missing terminating ';' for -exec";
      switch (mode) {
      case 'batch': {
        let placeholderIndex = -1;
        for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
          if (argv[argumentIndex] !== '{}') continue;
          if (placeholderIndex !== -1) {
            return "only one '{}' is supported with '-exec ... {} +'";
          }
          placeholderIndex = argumentIndex;
        }
        if (placeholderIndex === -1) {
          return "only one '{}' is supported with '-exec ... {} +'";
        }
        if (placeholderIndex !== argv.length - 1) {
          return "'{}' must appear by itself immediately before '+' in '-exec ... {} +'";
        }
        if (argv.some((arg) => arg !== '{}' && arg.includes('{}'))) {
          return "'{}' must appear by itself in '-exec ... {} +'";
        }
        break;
      }
      case 'single':
        break;
      default: {
        const _ex: never = mode;
        return `Unhandled -exec mode: ${_ex}`;
      }
      }

      return {
        kind: 'exec',
        id: nextExecId++,
        mode,
        command,
        args: argv.slice(1),
      };
    }
    default:
      return `unknown predicate '${token}'`;
    }
  }

  if (expressionTokens.length === 0) {
    return { ok: true, traversal, expr: { kind: 'true' }, hasAction: false };
  }

  const expr = parseExpression();
  if (typeof expr === 'string') {
    return { ok: false, message: expr };
  }

  if (index < expressionTokens.length) {
    const token = expressionTokens[index];
    return { ok: false, message: `unexpected token: ${token}` };
  }

  return {
    ok: true,
    traversal,
    expr,
    hasAction: containsAction({ expr }),
  };
}

async function resolveFindExpressionReferences({
  expr,
  context,
}: {
  expr: FindExpression,
  context: WeshCommandContext,
}): Promise<FindExpression> {
  type ResolveFrame =
    | { kind: 'evaluate', expr: FindExpression }
    | { kind: 'binary-left', operator: 'and' | 'or' | 'comma', right: FindExpression }
    | { kind: 'binary-combine', operator: 'and' | 'or' | 'comma', left: FindExpression }
    | { kind: 'not-combine' };

  const frames: ResolveFrame[] = [{ kind: 'evaluate', expr }];
  const results: FindExpression[] = [];
  while (frames.length > 0) {
    const frame = frames.pop()!;
    switch (frame.kind) {
    case 'evaluate': {
      const current = frame.expr;
      switch (current.kind) {
      case 'and':
      case 'or':
      case 'comma':
        frames.push({ kind: 'binary-left', operator: current.kind, right: current.right });
        frames.push({ kind: 'evaluate', expr: current.left });
        break;
      case 'not':
        frames.push({ kind: 'not-combine' });
        frames.push({ kind: 'evaluate', expr: current.expr });
        break;
      case 'newer': {
        const stat = await context.files.stat({
          path: resolvePath({
            cwd: context.cwd,
            path: current.referencePath,
          }),
        });
        results.push({
          kind: 'newer',
          referencePath: current.referencePath,
          referenceMtime: stat.mtime,
        });
        break;
      }
      case 'name':
      case 'path':
      case 'linkName':
      case 'regex':
      case 'type':
      case 'empty':
      case 'size':
      case 'age':
      case 'perm':
      case 'print':
      case 'print0':
      case 'prune':
      case 'delete':
      case 'quit':
      case 'true':
      case 'false':
      case 'exec':
        results.push(current);
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled find expression: ${_ex}`);
      }
      }
      break;
    }
    case 'binary-left': {
      const left = results.pop();
      if (left === undefined) throw new Error('find reference resolution result stack is empty');
      frames.push({ kind: 'binary-combine', operator: frame.operator, left });
      frames.push({ kind: 'evaluate', expr: frame.right });
      break;
    }
    case 'binary-combine': {
      const right = results.pop();
      if (right === undefined) throw new Error('find reference resolution result stack is empty');
      results.push({ kind: frame.operator, left: frame.left, right });
      break;
    }
    case 'not-combine': {
      const resolved = results.pop();
      if (resolved === undefined) throw new Error('find reference resolution result stack is empty');
      results.push({ kind: 'not', expr: resolved });
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled find reference resolution frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (results.length !== 1) {
    throw new Error(`find reference resolution produced ${results.length} results`);
  }
  return results[0]!;
}

async function evaluateExpression({
  expr,
  entry,
  context,
  pendingExecBatches,
  stdout,
  evaluationTime,
}: {
  expr: FindExpression,
  entry: FindEntry,
  context: WeshCommandContext,
  pendingExecBatches: Map<number, PendingExecBatch>,
  stdout: FindOutputWriter,
  evaluationTime: number,
}): Promise<FindEvaluationResult> {
  type EvaluationFrame =
    | { kind: 'evaluate', expr: FindExpression }
    | { kind: 'after-left', operator: 'and' | 'or' | 'comma', right: FindExpression }
    | { kind: 'combine', operator: 'and' | 'or' | 'comma', left: FindEvaluationResult }
    | { kind: 'not-combine' };

  const frames: EvaluationFrame[] = [{ kind: 'evaluate', expr }];
  const results: FindEvaluationResult[] = [];
  while (frames.length > 0) {
    const frame = frames.pop()!;
    switch (frame.kind) {
    case 'evaluate': {
      const current = frame.expr;
      switch (current.kind) {
      case 'and':
      case 'or':
      case 'comma':
        frames.push({ kind: 'after-left', operator: current.kind, right: current.right });
        frames.push({ kind: 'evaluate', expr: current.left });
        break;
      case 'not':
        frames.push({ kind: 'not-combine' });
        frames.push({ kind: 'evaluate', expr: current.expr });
        break;
      case 'name':
      case 'path':
      case 'linkName':
      case 'regex':
      case 'type':
      case 'empty':
      case 'size':
      case 'age':
      case 'perm':
      case 'newer':
      case 'print':
      case 'print0':
      case 'prune':
      case 'delete':
      case 'quit':
      case 'true':
      case 'false':
      case 'exec':
        results.push(await evaluateLeafExpression({
          expr: current,
          entry,
          context,
          pendingExecBatches,
          stdout,
          evaluationTime,
        }));
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled find expression: ${_ex}`);
      }
      }
      break;
    }
    case 'after-left': {
      const left = results.pop();
      if (left === undefined) throw new Error('find evaluation result stack is empty');
      switch (frame.operator) {
      case 'and':
        if (!left.matched || left.shouldQuit) {
          results.push(left);
          break;
        }
        frames.push({ kind: 'combine', operator: 'and', left });
        frames.push({ kind: 'evaluate', expr: frame.right });
        break;
      case 'or':
        if (left.matched) {
          results.push(left);
          break;
        }
        frames.push({ kind: 'combine', operator: 'or', left });
        frames.push({ kind: 'evaluate', expr: frame.right });
        break;
      case 'comma':
        if (left.shouldQuit) {
          results.push(left);
          break;
        }
        frames.push({ kind: 'combine', operator: 'comma', left });
        frames.push({ kind: 'evaluate', expr: frame.right });
        break;
      default: {
        const _ex: never = frame.operator;
        throw new Error(`Unhandled find evaluation operator: ${_ex}`);
      }
      }
      break;
    }
    case 'combine': {
      const right = results.pop();
      if (right === undefined) throw new Error('find evaluation result stack is empty');
      switch (frame.operator) {
      case 'and':
        results.push({
          matched: frame.left.matched && right.matched,
          actionInvoked: frame.left.actionInvoked || right.actionInvoked,
          shouldPrune: frame.left.shouldPrune || right.shouldPrune,
          shouldQuit: frame.left.shouldQuit || right.shouldQuit,
          exitCode: frame.left.exitCode !== 0 ? frame.left.exitCode : right.exitCode,
        });
        break;
      case 'or':
        results.push({
          matched: right.matched,
          actionInvoked: frame.left.actionInvoked || right.actionInvoked,
          shouldPrune: frame.left.shouldPrune || right.shouldPrune,
          shouldQuit: frame.left.shouldQuit || right.shouldQuit,
          exitCode: frame.left.exitCode !== 0 ? frame.left.exitCode : right.exitCode,
        });
        break;
      case 'comma':
        results.push({
          matched: right.matched,
          actionInvoked: frame.left.actionInvoked || right.actionInvoked,
          shouldPrune: frame.left.shouldPrune || right.shouldPrune,
          shouldQuit: right.shouldQuit,
          exitCode: frame.left.exitCode !== 0 ? frame.left.exitCode : right.exitCode,
        });
        break;
      default: {
        const _ex: never = frame.operator;
        throw new Error(`Unhandled find evaluation operator: ${_ex}`);
      }
      }
      break;
    }
    case 'not-combine': {
      const inner = results.pop();
      if (inner === undefined) throw new Error('find evaluation result stack is empty');
      results.push({
        matched: !inner.matched,
        actionInvoked: inner.actionInvoked,
        shouldPrune: inner.shouldPrune,
        shouldQuit: inner.shouldQuit,
        exitCode: inner.exitCode,
      });
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled find evaluation frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (results.length !== 1) {
    throw new Error(`find evaluation produced ${results.length} results`);
  }
  return results[0]!;
}

async function evaluateLeafExpression({
  expr,
  entry,
  context,
  pendingExecBatches,
  stdout,
  evaluationTime,
}: {
  expr: FindExpression,
  entry: FindEntry,
  context: WeshCommandContext,
  pendingExecBatches: Map<number, PendingExecBatch>,
  stdout: FindOutputWriter,
  evaluationTime: number,
}): Promise<FindEvaluationResult> {
  switch (expr.kind) {
  case 'and':
  case 'or':
  case 'comma':
  case 'not':
    throw new Error(`find composite expression reached leaf evaluator: ${expr.kind}`);
  case 'name': {
    const name = expr.asciiCaseFold ? foldAsciiCase({ value: entry.name }) : entry.name;
    return expr.compiledPattern.test(name) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'path':
    return expr.compiledPattern.test(entry.displayPath) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'linkName': {
    switch (entry.type) {
    case 'symlink': {
      const target = await context.files.readlinkEntry({ entry: asSymlinkEntryRef({ entry: entry.entryRef }) });
      const comparableTarget = expr.asciiCaseFold ? foldAsciiCase({ value: target }) : target;
      return expr.compiledPattern.test(comparableTarget) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
    }
    case 'directory':
    case 'file':
    case 'fifo':
    case 'chardev':
      return EVAL_NOT_MATCHED;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled find entry type: ${_ex}`);
    }
    }
  }
  case 'regex':
    return expr.pattern.test(entry.displayPath) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'type':
    return expr.expected.includes(entry.type) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'empty':
    switch (entry.type) {
    case 'directory': {
      for await (const _ of context.files.readDirEntry({ entry: asDirectoryEntryRef({ entry: entry.entryRef }) })) {
        return EVAL_NOT_MATCHED;
      }
      return EVAL_MATCHED;
    }
    case 'file':
      return entry.size === 0 ? EVAL_MATCHED : EVAL_NOT_MATCHED;
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return EVAL_NOT_MATCHED;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  case 'size': {
    const size = BigInt(entry.size);
    const unitSize = BigInt(expr.unitSize);
    const measuredSize = expr.roundUp && size > 0n
      ? (size + unitSize - 1n) / unitSize
      : size / unitSize;
    let matched: boolean;
    switch (expr.comparison) {
    case 'eq': matched = measuredSize === expr.count; break;
    case 'lt': matched = measuredSize < expr.count; break;
    case 'gt': matched = measuredSize > expr.count; break;
    default: {
      const _ex: never = expr.comparison;
      throw new Error(`Unhandled size comparison: ${_ex}`);
    }
    }
    return matched ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'age': {
    const fractionalAge = (evaluationTime - entry.mtime) / expr.unitMilliseconds;
    let matched: boolean;
    switch (expr.rounding) {
    case 'ceilExact':
      switch (expr.comparison) {
      case 'eq': matched = fractionalAge > expr.count - 1 && fractionalAge <= expr.count; break;
      case 'lt': matched = fractionalAge < expr.count; break;
      case 'gt': matched = fractionalAge > expr.count; break;
      default: {
        const _ex: never = expr.comparison;
        throw new Error(`Unhandled age comparison: ${_ex}`);
      }
      }
      break;
    case 'floorAll':
      switch (expr.comparison) {
      case 'eq': matched = fractionalAge >= expr.count && fractionalAge < expr.count + 1; break;
      case 'lt': matched = fractionalAge < expr.count; break;
      case 'gt': matched = fractionalAge >= expr.count + 1; break;
      default: {
        const _ex: never = expr.comparison;
        throw new Error(`Unhandled age comparison: ${_ex}`);
      }
      }
      break;
    default: {
      const _ex: never = expr.rounding;
      throw new Error(`Unhandled find age rounding: ${_ex}`);
    }
    }
    return matched ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'perm': {
    const permissionBits = entry.mode & 0o7777;
    let matched: boolean;
    switch (expr.matchMode) {
    case 'exact': matched = permissionBits === expr.mode; break;
    case 'all': matched = (permissionBits & expr.mode) === expr.mode; break;
    case 'any': matched = expr.mode === 0 || (permissionBits & expr.mode) !== 0; break;
    default: {
      const _ex: never = expr.matchMode;
      throw new Error(`Unhandled permission match mode: ${_ex}`);
    }
    }
    return matched ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'newer':
    return entry.mtime > expr.referenceMtime ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'print':
    await stdout.write({ text: `${entry.displayPath}\n` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'print0':
    await stdout.write({ text: `${entry.displayPath}\0` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'prune':
    return { matched: true, actionInvoked: true, shouldPrune: true, shouldQuit: false, exitCode: 0 };
  case 'delete':
    switch (entry.type) {
    case 'directory':
      await context.files.rmdir({ path: entry.fullPath });
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.files.unlink({ path: entry.fullPath });
      break;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'quit':
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: true, exitCode: 0 };
  case 'true':
    return EVAL_MATCHED;
  case 'false':
    return EVAL_NOT_MATCHED;
  case 'exec': {
    const execMode: 'single' | 'batch' = expr.mode;
    switch (execMode) {
    case 'batch': {
      let pending = pendingExecBatches.get(expr.id);
      if (pending === undefined) {
        pending = {
          id: expr.id,
          command: expr.command,
          argsTemplate: expr.args,
          entries: [],
          argumentBytes: getStaticBatchExecArgumentBytes({
            command: expr.command,
            argsTemplate: expr.args,
          }),
        };
        pendingExecBatches.set(expr.id, pending);
      }

      const pathArgumentBytes = getPathBatchExecArgumentBytes({
        argsTemplate: pending.argsTemplate,
        path: entry.displayPath,
      });
      let batchExitCode = 0;
      if (
        pending.entries.length > 0
        && (
          pending.entries.length + 1 > MAX_EXEC_BATCH_PATH_COUNT
          || pending.argumentBytes + pathArgumentBytes > MAX_EXEC_BATCH_ARGUMENT_BYTES
        )
      ) {
        batchExitCode = await flushPendingExecBatch({
          pending,
          context,
        });
      }

      pending.entries.push({
        path: entry.displayPath,
        entryRef: entry.entryRef,
      });
      pending.argumentBytes += pathArgumentBytes;
      if (
        pending.entries.length >= MAX_EXEC_BATCH_PATH_COUNT
        || pending.argumentBytes >= MAX_EXEC_BATCH_ARGUMENT_BYTES
      ) {
        const nextExitCode = await flushPendingExecBatch({
          pending,
          context,
        });
        if (nextExitCode !== 0) {
          batchExitCode = nextExitCode;
        }
      }

      return {
        matched: true,
        actionInvoked: true,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: batchExitCode,
      };
    }
    case 'single': {
      const invocation = buildSingleExecInvocation({
        argsTemplate: expr.args,
        entry: {
          path: entry.displayPath,
          entryRef: entry.entryRef,
        },
      });
      const result = await executeFindSubcommand({
        context,
        command: expr.command,
        args: invocation.args,
        argumentEntryRefs: invocation.argumentEntryRefs,
      });
      return {
        matched: result?.exitCode === 0,
        actionInvoked: true,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: 0,
      };
    }
    default: {
      const _ex: never = execMode;
      throw new Error(`Unhandled exec mode: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = expr;
    throw new Error(`Unhandled find expression: ${_ex}`);
  }
  }
}

function getStaticBatchExecArgumentBytes({
  command,
  argsTemplate,
}: {
  command: string,
  argsTemplate: readonly string[],
}): number {
  let bytes = utf8Encoder.encode(command).byteLength + 1;
  for (const arg of argsTemplate) {
    if (!arg.includes('{}')) {
      bytes += utf8Encoder.encode(arg).byteLength + 1;
    }
  }
  return bytes;
}

function getPathBatchExecArgumentBytes({
  argsTemplate,
  path,
}: {
  argsTemplate: readonly string[],
  path: string,
}): number {
  let bytes = 0;
  for (const arg of argsTemplate) {
    if (arg.includes('{}')) {
      bytes += utf8Encoder.encode(arg.replace(/\{\}/g, path)).byteLength + 1;
    }
  }
  return bytes;
}

function buildExecArgument({
  template,
  entry,
}: {
  template: string,
  entry: PendingExecBatchEntry,
}): {
  value: string,
  entryRef: WeshEntryRef | undefined,
} {
  return {
    value: template.replace(/\{\}/g, entry.path),
    entryRef: template === '{}' ? entry.entryRef : undefined,
  };
}

function buildSingleExecInvocation({
  argsTemplate,
  entry,
}: {
  argsTemplate: string[],
  entry: PendingExecBatchEntry,
}): ExecInvocation {
  const args: string[] = [];
  const argumentEntryRefs: Array<WeshEntryRef | undefined> = [];

  for (const template of argsTemplate) {
    const argument = buildExecArgument({ template, entry });
    args.push(argument.value);
    argumentEntryRefs.push(argument.entryRef);
  }

  return { args, argumentEntryRefs };
}

function buildBatchExecInvocation({
  argsTemplate,
  entries,
}: {
  argsTemplate: string[],
  entries: PendingExecBatchEntry[],
}): ExecInvocation {
  const args: string[] = [];
  const argumentEntryRefs: Array<WeshEntryRef | undefined> = [];

  for (const template of argsTemplate) {
    if (!template.includes('{}')) {
      args.push(template);
      argumentEntryRefs.push(undefined);
      continue;
    }

    for (const entry of entries) {
      const argument = buildExecArgument({ template, entry });
      args.push(argument.value);
      argumentEntryRefs.push(argument.entryRef);
    }
  }

  return { args, argumentEntryRefs };
}

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
}): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry as WeshEntryRef<'directory'>;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${String(_ex)}`);
  }
  }
}

function asSymlinkEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
}): WeshEntryRef<'symlink'> {
  switch (entry.type) {
  case 'symlink':
    return entry;
  case 'directory':
  case 'file':
  case 'fifo':
  case 'chardev':
    throw new Error(`Not a symbolic link: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${String(_ex)}`);
  }
  }
}

async function flushPendingExecBatch({
  pending,
  context,
}: {
  pending: PendingExecBatch,
  context: WeshCommandContext,
}): Promise<number> {
  if (pending.entries.length === 0) return 0;

  const entries = pending.entries;
  pending.entries = [];
  pending.argumentBytes = getStaticBatchExecArgumentBytes({
    command: pending.command,
    argsTemplate: pending.argsTemplate,
  });
  const invocation = buildBatchExecInvocation({
    argsTemplate: pending.argsTemplate,
    entries,
  });
  const result = await executeFindSubcommand({
    context,
    command: pending.command,
    args: invocation.args,
    argumentEntryRefs: invocation.argumentEntryRefs,
  });
  return result?.exitCode ?? 1;
}

async function executeFindSubcommand({
  context,
  command,
  args,
  argumentEntryRefs,
}: {
  context: WeshCommandContext,
  command: string,
  args: string[],
  argumentEntryRefs: Array<WeshEntryRef | undefined>,
}): Promise<WeshCommandResult | undefined> {
  try {
    return await context.executeCommand({
      command,
      args,
      argumentEntryRefs,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== `Command not found: ${command}`) throw error;
    await context.text().error({
      text: `find: '${command}': No such file or directory\n`,
    });
    return undefined;
  }
}

function hasExpressionAction({
  expr,
  action,
}: {
  expr: FindExpression,
  action: 'delete' | 'prune',
}): boolean {
  const pending: FindExpression[] = [expr];
  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
    case 'and':
    case 'or':
    case 'comma':
      pending.push(current.right, current.left);
      break;
    case 'not':
      pending.push(current.expr);
      break;
    case 'delete':
      switch (action) {
      case 'delete':
        return true;
      case 'prune':
        break;
      default: {
        const _ex: never = action;
        throw new Error(`Unhandled find action: ${_ex}`);
      }
      }
      break;
    case 'prune':
      switch (action) {
      case 'prune':
        return true;
      case 'delete':
        break;
      default: {
        const _ex: never = action;
        throw new Error(`Unhandled find action: ${_ex}`);
      }
      }
      break;
    case 'name':
    case 'path':
    case 'linkName':
    case 'regex':
    case 'type':
    case 'empty':
    case 'size':
    case 'age':
    case 'perm':
    case 'newer':
    case 'print':
    case 'print0':
    case 'quit':
    case 'true':
    case 'false':
    case 'exec':
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled find expression: ${_ex}`);
    }
    }
  }
  return false;
}

function hasDeleteAction({
  expr,
}: {
  expr: FindExpression,
}): boolean {
  return hasExpressionAction({ expr, action: 'delete' });
}

function hasPruneAction({
  expr,
}: {
  expr: FindExpression,
}): boolean {
  return hasExpressionAction({ expr, action: 'prune' });
}

export const findCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'find',
    description: 'Search for files in a directory hierarchy',
    usage: 'find [path...] [expression]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const earlyExitRequest = findEarlyExitRequest({
      args: context.args,
      characterLocaleMode,
    });
    switch (earlyExitRequest) {
    case 'help': {
      const helpStatus = await maybeWriteStandaloneCommandHelp({
        context,
        command: 'find',
        argvSpec: findHelpArgvSpec,
        mode: 'help-requested',
      });
      switch (helpStatus) {
      case 'handled':
        return { exitCode: 0 };
      case 'not-handled':
        break;
      default: {
        const _ex: never = helpStatus;
        throw new Error(`Unhandled help status: ${_ex}`);
      }
      }
      break;
    }
    case 'version':
      await context.text().print({ text: 'find (Wesh findutils) 1.0\n' });
      return { exitCode: 0 };
    case undefined:
      break;
    default: {
      const _ex: never = earlyExitRequest;
      throw new Error(`Unhandled find early exit request: ${_ex}`);
    }
    }

    const split = splitFindLeadingOptions({ args: context.args });
    const parsed = parseFindLikeArgv({ args: split.remainingArgs });
    const expression = tokenizeFindExpression({
      tokens: parsed.expressionTokens,
      characterLocaleMode,
      symlinkMode: resolveFindLeadingSymlinkMode({ leadingOptions: split.leadingOptions }),
    });

    if (!expression.ok) {
      await writeCommandUsageError({
        context,
        command: 'find',
        message: `find: ${expression.message}`,
      });
      return { exitCode: 1 };
    }

    if (
      hasDeleteAction({ expr: expression.expr })
      && hasPruneAction({ expr: expression.expr })
      && !expression.traversal.depthFirst
    ) {
      await writeCommandUsageError({
        context,
        command: 'find',
        message: 'find: -delete automatically enables -depth, so -prune is ineffective; pass -depth explicitly to continue',
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    const pendingExecBatches = new Map<number, PendingExecBatch>();
    const stdout = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    let shouldQuit = false;
    const activeDirectoryPaths = new Set<string>();
    const traversal: FindTraversalOptions = {
      ...expression.traversal,
      depthFirst: expression.traversal.depthFirst || hasDeleteAction({ expr: expression.expr }),
    };
    let resolvedExpression: FindExpression;

    try {
      resolvedExpression = await resolveFindExpressionReferences({
        expr: expression.expr,
        context,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await writeCommandUsageError({
        context,
        command: 'find',
        message: `find: ${message}`,
      });
      return { exitCode: 1 };
    }

    const canSkipFullStat = canEvaluateWithoutFullStat({
      expr: resolvedExpression,
    });
    const evaluationTime = Date.now();

    const isNotFoundError = ({ error }: { error: unknown }): boolean => {
      if (error instanceof DOMException) return error.name === 'NotFoundError';
      return error instanceof Error && error.message.includes('NotFoundError');
    };

    const resolveTraversalEntry = async ({
      path,
      isCommandLineArgument,
    }: {
      path: string,
      isCommandLineArgument: boolean,
    }): Promise<WeshEntryRef> => {
      const finalSymlinkTreatment = (() => {
        switch (traversal.symlinkMode) {
        case 'logical':
          return 'follow' as const;
        case 'command-line':
          return isCommandLineArgument ? 'follow' as const : 'no-follow' as const;
        case 'physical':
          return 'no-follow' as const;
        default: {
          const _ex: never = traversal.symlinkMode;
          throw new Error(`Unhandled symlink mode: ${_ex}`);
        }
        }
      })();

      switch (finalSymlinkTreatment) {
      case 'no-follow':
        return await context.files.resolveEntry({
          path,
          finalSymlinkTreatment,
        });
      case 'follow': {
        const physicalEntry = await context.files.resolveEntry({
          path,
          finalSymlinkTreatment: 'no-follow',
        });
        try {
          return await context.files.resolveEntry({
            path,
            finalSymlinkTreatment,
          });
        } catch (error: unknown) {
          switch (physicalEntry.type) {
          case 'symlink':
            if (isNotFoundError({ error })) return physicalEntry;
            break;
          case 'directory':
          case 'file':
          case 'fifo':
          case 'chardev':
            break;
          default: {
            const _ex: never = physicalEntry;
            throw new Error(`Unhandled entry type: ${String(_ex)}`);
          }
          }
          throw error;
        }
      }
      default: {
        const _ex: never = finalSymlinkTreatment;
        throw new Error(`Unhandled final symlink treatment: ${_ex}`);
      }
      }
    };

    const createFindEntry = async ({
      entryRef,
      operationPath,
      displayPath,
      name,
    }: {
      entryRef: WeshEntryRef,
      operationPath: string,
      displayPath: string,
      name: string,
    }): Promise<FindEntry> => {
      if (canSkipFullStat) {
        return {
          entryRef,
          fullPath: operationPath,
          displayPath,
          type: entryRef.type,
          name,
          size: 0,
          mode: 0,
          mtime: 0,
        };
      }

      const stat = await context.files.statEntry({ entry: entryRef });
      return {
        entryRef,
        fullPath: operationPath,
        displayPath,
        type: stat.type,
        name,
        size: stat.size,
        mode: stat.mode,
        mtime: stat.mtime,
      };
    };

    const walk = async ({
      entryRef,
      operationPath,
      displayPath,
      name,
      depth,
    }: {
      entryRef: WeshEntryRef,
      operationPath: string,
      displayPath: string,
      name: string,
      depth: number,
    }): Promise<void> => {
      if (shouldQuit) return;

      try {
        const finalizedEntry = await createFindEntry({
          entryRef,
          operationPath,
          displayPath,
          name,
        });
        const directoryIdentity = (() => {
          switch (finalizedEntry.type) {
          case 'directory':
            return finalizedEntry.entryRef.fullPath;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            return undefined;
          default: {
            const _ex: never = finalizedEntry.type;
            throw new Error(`Unhandled find entry type: ${_ex}`);
          }
          }
        })();
        if (directoryIdentity !== undefined && activeDirectoryPaths.has(directoryIdentity)) {
          await context.text().error({ text: `find: ${displayPath}: symbolic link cycle
` });
          exitCode = 1;
          return;
        }
        let shouldPruneChildren = false;
        let evaluation: FindEvaluationResult | undefined;
        const shouldEvaluate = depth >= traversal.minDepth;

        if (!traversal.depthFirst && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry: finalizedEntry,
            context,
            pendingExecBatches,
            stdout,
            evaluationTime,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await stdout.write({ text: `${displayPath}\n` });
          }
          shouldPruneChildren = evaluation.shouldPrune;
        }

        const canDescend = finalizedEntry.type === 'directory'
          && !shouldPruneChildren
          && !shouldQuit
          && (traversal.maxDepth === undefined || depth < traversal.maxDepth);

        if (canDescend) {
          const displayPathPrefix = displayPath === '/' ? '' : displayPath;
          const directoryEntry = asDirectoryEntryRef({
            entry: finalizedEntry.entryRef,
          });
          activeDirectoryPaths.add(directoryEntry.fullPath);
          try {
            for await (const child of context.files.readDirEntry({ entry: directoryEntry })) {
              const childDisplayPath = `${displayPathPrefix}/${child.name}`;
              const childOperationPath = child.fullPath;
              const childEntry = traversal.symlinkMode === 'logical' && child.type === 'symlink'
                ? await resolveTraversalEntry({
                  path: child.fullPath,
                  isCommandLineArgument: false,
                })
                : child;
              await walk({
                entryRef: childEntry,
                operationPath: childOperationPath,
                displayPath: childDisplayPath,
                name: child.name,
                depth: depth + 1,
              });
              if (shouldQuit) break;
            }
          } finally {
            activeDirectoryPaths.delete(directoryEntry.fullPath);
          }
        }

        if (traversal.depthFirst && !shouldQuit && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry: finalizedEntry,
            context,
            pendingExecBatches,
            stdout,
            evaluationTime,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await stdout.write({ text: `${displayPath}\n` });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `find: ${displayPath}: ${message}\n` });
        exitCode = 1;
      }
    };

    for (const path of parsed.paths) {
      const fullPath = resolvePath({ cwd: context.cwd, path });
      try {
        await walk({
          entryRef: await resolveTraversalEntry({
            path: fullPath,
            isCommandLineArgument: true,
          }),
          operationPath: fullPath,
          displayPath: path,
          name: basename({ path }),
          depth: 0,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `find: ${path}: ${message}\n` });
        exitCode = 1;
      }
      if (shouldQuit) break;
    }

    for (const pendingExecBatch of pendingExecBatches.values()) {
      const batchExitCode = await flushPendingExecBatch({
        pending: pendingExecBatch,
        context,
      });
      if (batchExitCode !== 0) {
        exitCode = batchExitCode;
      }
    }

    await stdout.flush();
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  canEvaluateWithoutFullStat,
  evaluateExpression,
  resolveFindExpressionReferences,
  tokenizeFindExpression,
};
