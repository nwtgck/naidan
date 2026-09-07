import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { parseStandardArgv, type ArgvOptionOccurrence, type ArgvSpecialParseResult, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { parseXargsDelimiter } from '@/features/wesh/commands/xargs/parse-input';
import {
  iterateReadableStreamChunks,
  iterateCommandDataTextChunks,
  iterateXargsInputLines,
  iterateXargsDelimitedItems,
  iterateXargsInsertItems,
  iterateXargsLogicalLines,
  iterateXargsStandardItems,
  iterateXargsTextIgnoringNulSuffixes,
  XargsInputError,
} from '@/features/wesh/commands/xargs/stream-input';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult, WeshFileHandle } from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';

const DEFAULT_MAX_CHARS = 131072;
const MAX_AUTOMATIC_PARALLELISM = 32;
const XARGS_VERSION = 'xargs (wesh) 0.25.1-dev';
const XARGS_IGNORED_NUL_WARNING = 'xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n';

function parseXargsInteger({
  value,
  minimum,
  label,
}: {
  value: string,
  minimum: number,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { ok: false, message: `invalid ${label} value '${value}'` };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return { ok: false, message: `invalid ${label} value '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseXargsMaxProcs({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const parsed = parseXargsInteger({
    value,
    minimum: 0,
    label: 'max-procs',
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value > MAX_AUTOMATIC_PARALLELISM) {
    return {
      ok: false,
      message: `max-procs value '${value}' exceeds safety limit ${MAX_AUTOMATIC_PARALLELISM}`,
    };
  }
  return parsed;
}

function parseDeprecatedIOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '--replace') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '--replace', key: 'replace', value: '{}' }],
    };
  }

  if (token === '-i') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-i', key: 'replace', value: '{}' }],
    };
  }

  if (token.startsWith('-i') && token.length > 2) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-i', key: 'replace', value: token.slice(2) }],
    };
  }

  return undefined;
}

function parseDeprecatedLOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '-l') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-l', key: 'maxLines', value: 1 }],
    };
  }

  if (/^-l\+?\d+$/.test(token)) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-l', key: 'maxLines', value: Number(token.slice(2)) }],
    };
  }

  return undefined;
}

function parseDeprecatedEOption({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '--eof') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [],
    };
  }

  if (token === '-e') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [],
    };
  }

  if (token.startsWith('-e') && token.length > 2) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [],
      occurrences: [{ kind: 'value', option: '-e', key: 'eofString', value: token.slice(2) }],
    };
  }

  return undefined;
}

const xargsArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: '0',
      long: 'null',
      effects: [{ key: 'nullDelimited', value: true }],
      help: { summary: 'input items are terminated by NUL, not whitespace', category: 'common' },
    },
    {
      kind: 'value',
      short: 'a',
      long: 'arg-file',
      key: 'argFile',
      valueName: 'FILE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'read items from FILE instead of standard input', valueName: 'FILE', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'max-args',
      key: 'maxArgs',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseXargsInteger({
        value,
        minimum: 1,
        label: 'max-args',
      }),
      help: { summary: 'use at most MAX arguments per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'P',
      long: 'max-procs',
      key: 'maxProcs',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseXargsMaxProcs({ value }),
      help: { summary: 'run up to MAX processes at a time', valueName: 'MAX', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 'L',
      long: 'max-lines',
      key: 'maxLines',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseXargsInteger({
        value,
        minimum: 1,
        label: 'max-lines',
      }),
      help: { summary: 'use at most MAX nonblank input lines per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 's',
      long: 'max-chars',
      key: 'maxChars',
      valueName: 'MAX',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseXargsInteger({
        value,
        minimum: 1,
        label: 'max-chars',
      }),
      help: { summary: 'use at most MAX characters per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'd',
      long: 'delimiter',
      key: 'delimiter',
      valueName: 'DELIM',
      allowAttachedValue: true,
      parseValue: ({ value }) => {
        const parsed = parseXargsDelimiter({ value });
        return parsed.ok ? { ok: true, value: parsed.delimiter } : parsed;
      },
      help: { summary: 'input items are terminated by DELIM, not whitespace', valueName: 'DELIM', category: 'common' },
    },
    {
      kind: 'value',
      short: 'I',
      long: 'replace',
      key: 'replace',
      valueName: 'REPLSTR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'replace REPLSTR in initial arguments with each input item', valueName: 'REPLSTR', category: 'common' },
    },
    {
      kind: 'value',
      short: 'E',
      long: 'eof',
      key: 'eofString',
      valueName: 'EOFSTR',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'set logical end-of-file marker string', valueName: 'EOFSTR', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'o',
      long: 'open-tty',
      effects: [{ key: 'openTty', value: true }],
      help: { summary: 'reopen stdin as /dev/tty in the child before executing the command', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'p',
      long: 'interactive',
      effects: [{ key: 'interactive', value: true }, { key: 'trace', value: true }],
      help: { summary: 'prompt before running each command line; implies --verbose', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'r',
      long: 'no-run-if-empty',
      effects: [{ key: 'noRunIfEmpty', value: true }],
      help: { summary: 'do not run command if there is no input', category: 'common' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'verbose',
      effects: [{ key: 'trace', value: true }],
      help: { summary: 'print command line before executing it', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'x',
      long: 'exit',
      effects: [{ key: 'exitIfTooLong', value: true }],
      help: { summary: 'exit if the size is exceeded', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'version',
      effects: [{ key: 'version', value: true }],
      help: { summary: 'output version information and exit', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'show-limits',
      effects: [{ key: 'showLimits', value: true }],
      help: { summary: 'display command-line length limits and exit', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    parseDeprecatedIOption,
    parseDeprecatedLOption,
    parseDeprecatedEOption,
  ],
};

const XARGS_DEPRECATED_OPTIONAL_SHORT_OPTIONS = new Set(['e', 'i', 'l']);
const XARGS_SHORT_OPTIONS = new Map(
  xargsArgvSpec.options.flatMap((option) => option.short === undefined ? [] : [[option.short, option] as const]),
);
const XARGS_LONG_OPTIONS = new Map(
  xargsArgvSpec.options.flatMap((option) => option.long === undefined ? [] : [[option.long, option] as const]),
);

function normalizeXargsDeprecatedOptionalShortBundles({
  args,
}: {
  args: string[],
}): string[] {
  const normalized: string[] = [];

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;

    if (token === '--') {
      normalized.push(...args.slice(index));
      break;
    }

    let specialConsumeCount: number | undefined;
    for (const specialParser of xargsArgvSpec.specialTokenParsers) {
      const result = specialParser({
        token,
        nextToken: args[index + 1],
      });
      if (result === undefined) continue;
      specialConsumeCount = result.consumeCount;
      break;
    }
    if (specialConsumeCount !== undefined) {
      normalized.push(...args.slice(index, index + specialConsumeCount));
      index += specialConsumeCount;
      continue;
    }

    if (token.startsWith('--') && token.length > 2) {
      normalized.push(token);
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf('=');
      const key = equalsIndex >= 0 ? optionBody.slice(0, equalsIndex) : optionBody;
      const option = XARGS_LONG_OPTIONS.get(key);
      index += 1;
      if (option?.kind === 'value' && equalsIndex < 0 && index < args.length) {
        normalized.push(args[index]!);
        index += 1;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      const shortBody = token.slice(1);
      let consumesNextValue = false;
      let rewritten = false;

      for (let shortIndex = 0; shortIndex < shortBody.length; shortIndex += 1) {
        const short = shortBody[shortIndex];
        if (short === undefined) continue;

        if (shortIndex > 0 && XARGS_DEPRECATED_OPTIONAL_SHORT_OPTIONS.has(short)) {
          normalized.push(
            `-${shortBody.slice(0, shortIndex)}`,
            `-${shortBody.slice(shortIndex)}`,
          );
          rewritten = true;
          break;
        }

        const option = XARGS_SHORT_OPTIONS.get(short);
        if (option === undefined) break;
        switch (option.kind) {
        case 'flag':
          continue;
        case 'value': {
          const attachedValue = shortBody.slice(shortIndex + 1);
          consumesNextValue = !(option.allowAttachedValue && attachedValue.length > 0);
          shortIndex = shortBody.length;
          break;
        }
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled xargs option kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }

      if (!rewritten) {
        normalized.push(token);
      }
      index += 1;
      if (!rewritten && consumesNextValue && index < args.length) {
        normalized.push(args[index]!);
        index += 1;
      }
      continue;
    }

    normalized.push(token);
    index += 1;
  }

  return normalized;
}

function splitXargsArguments({
  args,
}: {
  args: string[],
}): { xargsArgs: string[], commandArgs: string[] } {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;

    if (token === '--') {
      return {
        xargsArgs: args.slice(0, index + 1),
        commandArgs: args.slice(index + 1),
      };
    }

    let specialConsumeCount: number | undefined;
    for (const specialParser of xargsArgvSpec.specialTokenParsers) {
      const result = specialParser({
        token,
        nextToken: args[index + 1],
      });
      if (result === undefined) continue;
      specialConsumeCount = result.consumeCount;
      break;
    }
    if (specialConsumeCount !== undefined) {
      index += specialConsumeCount;
      continue;
    }

    if (token.startsWith('--') && token.length > 2) {
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf('=');
      const key = equalsIndex >= 0 ? optionBody.slice(0, equalsIndex) : optionBody;
      const option = XARGS_LONG_OPTIONS.get(key);
      index += 1;
      if (option?.kind === 'value' && equalsIndex < 0 && index < args.length) {
        index += 1;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      const shortBody = token.slice(1);
      index += 1;
      for (let shortIndex = 0; shortIndex < shortBody.length; shortIndex += 1) {
        const short = shortBody[shortIndex];
        if (short === undefined) continue;
        const option = XARGS_SHORT_OPTIONS.get(short);
        if (option === undefined) break;
        switch (option.kind) {
        case 'flag':
          continue;
        case 'value': {
          const attachedValue = shortBody.slice(shortIndex + 1);
          if (!(option.allowAttachedValue && attachedValue.length > 0) && index < args.length) {
            index += 1;
          }
          shortIndex = shortBody.length;
          break;
        }
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled xargs option kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }
      continue;
    }

    return {
      xargsArgs: args.slice(0, index),
      commandArgs: args.slice(index),
    };
  }

  return { xargsArgs: args, commandArgs: [] };
}

function shellQuote({
  text,
  characterLocaleMode,
}: {
  text: string,
  characterLocaleMode: WeshCharacterLocaleMode,
}): string {
  const isSafePrintableWord = ({ value }: { value: string }): boolean => {
    if (value.length === 0) return false;
    for (const char of value) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint > 0x7f && characterLocaleMode === 'unicode') continue;
      if (!/[A-Za-z0-9_+,./:@%-]/u.test(char)) return false;
    }
    return true;
  };
  const quotePrintable = ({ value }: { value: string }): string => {
    if (value.length === 0) return "''";
    if (isSafePrintableWord({ value })) return value;
    if (
      value.includes('\'')
      && !value.includes('"')
      && !value.includes('$')
      && !value.includes('`')
      && !value.includes('\\')
    ) {
      return `"${value}"`;
    }
    return `'${value.replaceAll('\'', `'\\''`)}'`;
  };
  const quotePrintableSegment = ({ value }: { value: string }): string => {
    if (
      value.includes('\'')
      && !value.includes('"')
      && !value.includes('$')
      && !value.includes('`')
      && !value.includes('\\')
    ) {
      return `"${value}"`;
    }
    return `'${value.replaceAll('\'', `'\\''`)}'`;
  };
  const escapeByte = ({ byte }: { byte: number }): string => {
    switch (byte) {
    case 0x07: return '\\a';
    case 0x08: return '\\b';
    case 0x09: return '\\t';
    case 0x0a: return '\\n';
    case 0x0b: return '\\v';
    case 0x0c: return '\\f';
    case 0x0d: return '\\r';
    default: return `\\${byte.toString(8).padStart(3, '0')}`;
    }
  };
  const isPrintableCharacter = ({ char }: { char: string }): boolean => {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f) return false;
    if (characterLocaleMode === 'ascii' && codePoint > 0x7f) return false;
    return !/\p{C}/u.test(char);
  };

  type Segment = { readonly kind: 'printable', readonly value: string }
    | { readonly kind: 'escaped', readonly bytes: readonly number[] };
  const segments: Segment[] = [];
  let printable = '';
  let escaped: number[] = [];
  const flushPrintable = (): void => {
    if (printable.length === 0) return;
    segments.push({ kind: 'printable', value: printable });
    printable = '';
  };
  const flushEscaped = (): void => {
    if (escaped.length === 0) return;
    segments.push({ kind: 'escaped', bytes: escaped });
    escaped = [];
  };

  for (let index = 0; index < text.length;) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xdc80 && codeUnit <= 0xdcff) {
      flushPrintable();
      escaped.push(codeUnit - 0xdc00);
      index += 1;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    index += char.length;
    if (isPrintableCharacter({ char })) {
      flushEscaped();
      printable += char;
    } else {
      flushPrintable();
      escaped.push(...encodeCommandDataText({ text: char }));
    }
  }
  flushPrintable();
  flushEscaped();

  if (segments.length === 0) return "''";
  if (segments.every(segment => segment.kind === 'printable')) {
    return quotePrintable({ value: text });
  }

  const output: string[] = [];
  const firstSegment = segments[0]!;
  switch (firstSegment.kind) {
  case 'escaped':
    output.push("''");
    break;
  case 'printable':
    break;
  default: {
    const _exhaustive: never = firstSegment;
    throw new Error(`Unhandled first shell quote segment: ${String(_exhaustive)}`);
  }
  }
  for (const segment of segments) {
    switch (segment.kind) {
    case 'printable':
      output.push(quotePrintableSegment({ value: segment.value }));
      break;
    case 'escaped':
      output.push(`$'${segment.bytes.map(byte => escapeByte({ byte })).join('')}'`);
      break;
    default: {
      const _exhaustive: never = segment;
      throw new Error(`Unhandled shell quote segment: ${String(_exhaustive)}`);
    }
    }
  }
  return output.join('');
}

function createDevNullLikeHandle(): WeshFileHandle {
  return {
    async read() {
      return { bytesRead: 0 };
    },
    async write({ buffer, offset, length }) {
      const start = offset ?? 0;
      const written = length ?? (buffer.length - start);
      return { bytesWritten: written };
    },
    async close() {},
    async stat() {
      return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async truncate() {},
    async ioctl() {
      return { ret: 0 };
    },
  };
}

function describeConflictMode({
  mode,
}: {
  mode: 'replace' | 'maxArgs' | 'maxLines',
}): string {
  switch (mode) {
  case 'replace':
    return 'replace/-I/-i';
  case 'maxArgs':
    return 'max-args';
  case 'maxLines':
    return 'max-lines';
  default: {
    const _exhaustive: never = mode;
    throw new Error(`Unhandled xargs conflict mode: ${_exhaustive}`);
  }
  }
}

function isValueOccurrence(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function getLastValueOccurrence({
  occurrences,
  key,
}: {
  occurrences: ArgvOptionOccurrence[],
  key: string,
}): Extract<ArgvOptionOccurrence, { kind: 'value' }> | undefined {
  return [...occurrences].reverse().find((occurrence) => isValueOccurrence(occurrence, key));
}

type XargsInputMode =
  | { kind: 'standard' }
  | { kind: 'null' }
  | { kind: 'delimiter', delimiter: string };

type XargsExplicitDelimiterInputMode = Exclude<XargsInputMode, { kind: 'standard' }>;

function resolveInputMode({
  occurrences,
}: {
  occurrences: ArgvOptionOccurrence[],
}): XargsInputMode {
  let mode: XargsInputMode = { kind: 'standard' };
  for (const occurrence of occurrences) {
    if (
      occurrence.kind === 'value'
      && occurrence.key === 'delimiter'
      && typeof occurrence.value === 'string'
    ) {
      mode = { kind: 'delimiter', delimiter: occurrence.value };
      continue;
    }
    if (
      (occurrence.kind === 'flag' || occurrence.kind === 'special')
      && occurrence.effects.some((effect) => effect.key === 'nullDelimited' && effect.value === true)
    ) {
      mode = { kind: 'null' };
    }
  }
  return mode;
}

function createExplicitlyDelimitedXargsItems({
  textChunks,
  inputMode,
}: {
  textChunks: AsyncIterable<string>,
  inputMode: XargsExplicitDelimiterInputMode,
}): AsyncIterable<string> {
  switch (inputMode.kind) {
  case 'null':
    return iterateXargsDelimitedItems({ textChunks, delimiter: '\0' });
  case 'delimiter': {
    const filteredTextChunks = inputMode.delimiter === '\0'
      ? textChunks
      : iterateXargsTextIgnoringNulSuffixes({
        textChunks,
        boundary: { kind: 'delimiter', delimiter: inputMode.delimiter },
      });
    return iterateXargsDelimitedItems({
      textChunks: filteredTextChunks,
      delimiter: inputMode.delimiter,
    });
  }
  default: {
    const _ex: never = inputMode;
    throw new Error(`Unhandled xargs explicit delimiter input mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

async function* iterateXargsItemsAsLogicalLines({
  items,
}: {
  items: AsyncIterable<string>,
}): AsyncIterable<string[]> {
  for await (const item of items) {
    yield [item];
  }
}

type XargsModeOccurrence = Extract<ArgvOptionOccurrence, { kind: 'value' }> & {
  key: 'replace' | 'maxArgs' | 'maxLines',
};

function isXargsModeOccurrence(
  occurrence: ArgvOptionOccurrence,
): occurrence is XargsModeOccurrence {
  return occurrence.kind === 'value'
    && (occurrence.key === 'replace' || occurrence.key === 'maxArgs' || occurrence.key === 'maxLines');
}

async function resolveExecutionLimits({
  context,
  occurrences,
}: {
  context: WeshCommandContext,
  occurrences: ArgvOptionOccurrence[],
}): Promise<{
  replaceValue: string | undefined,
  maxArgs: number | undefined,
  maxLines: number | undefined,
}> {
  const conflictingOccurrences = occurrences.filter(isXargsModeOccurrence);

  let replaceValue: string | undefined;
  let maxArgs: number | undefined;
  let maxLines: number | undefined;
  let activeMode: 'replace' | 'maxArgs' | 'maxLines' | undefined;

  for (const occurrence of conflictingOccurrences) {
    switch (occurrence.key) {
    case 'replace': {
      if (activeMode !== undefined && activeMode !== 'replace') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --replace/-I/-i are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = typeof occurrence.value === 'string' ? occurrence.value : undefined;
      maxArgs = undefined;
      maxLines = undefined;
      activeMode = 'replace';
      break;
    }
    case 'maxArgs': {
      const nextValue = typeof occurrence.value === 'number' ? occurrence.value : undefined;
      if (activeMode === 'replace' && nextValue === 1) {
        break;
      }
      if (activeMode !== undefined && activeMode !== 'maxArgs') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --max-args are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = undefined;
      maxLines = undefined;
      maxArgs = nextValue;
      activeMode = 'maxArgs';
      break;
    }
    case 'maxLines': {
      if (activeMode !== undefined && activeMode !== 'maxLines') {
        await context.text().error({
          text: `xargs: warning: options --${describeConflictMode({ mode: activeMode })} and --max-lines are mutually exclusive; ignoring previous --${describeConflictMode({ mode: activeMode })} value\n`,
        });
      }
      replaceValue = undefined;
      maxArgs = undefined;
      maxLines = typeof occurrence.value === 'number' ? occurrence.value : undefined;
      activeMode = 'maxLines';
      break;
    }
    default: {
      const _exhaustive: never = occurrence.key;
      throw new Error(`Unhandled xargs mode occurrence: ${_exhaustive}`);
    }
    }
  }

  return {
    replaceValue,
    maxArgs,
    maxLines,
  };
}

interface XargsInvocation {
  readonly args: string[],
}

function getArgumentBytes({ value }: { value: string }): number {
  return encodeCommandDataText({ text: value }).byteLength;
}

function getCommandBytes({
  command,
  args,
}: {
  command: string,
  args: readonly string[],
}): number {
  let bytes = getArgumentBytes({ value: command }) + 1;
  for (const arg of args) {
    bytes += 1 + getArgumentBytes({ value: arg });
  }
  return bytes;
}

class XargsArgumentListTooLongError extends Error {}

async function* createBatchedInvocations({
  command,
  items,
  initialArgs,
  maxArgs,
  maxChars,
  exitIfTooLong,
  noRunIfEmpty,
}: {
  command: string,
  items: AsyncIterable<string>,
  initialArgs: readonly string[],
  maxArgs: number | undefined,
  maxChars: number,
  exitIfTooLong: boolean,
  noRunIfEmpty: boolean,
}): AsyncIterable<XargsInvocation> {
  let batch: string[] = [];
  let batchBytes = getCommandBytes({ command, args: initialArgs });
  let sawItem = false;

  const iterator = items[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<string>;
    try {
      next = await iterator.next();
    } catch (error: unknown) {
      if (batch.length > 0) {
        yield { args: [...initialArgs, ...batch] };
        batch = [];
      }
      throw error;
    }
    if (next.done) break;
    const item = next.value;
    sawItem = true;
    const itemBytes = 1 + getArgumentBytes({ value: item });
    const itemFitsEmptyBatch = getCommandBytes({ command, args: initialArgs }) + itemBytes <= maxChars;
    const exceedsMaxArgs = maxArgs !== undefined && batch.length + 1 > maxArgs;
    const exceedsMaxChars = batchBytes + itemBytes > maxChars;

    if (batch.length > 0 && exceedsMaxArgs) {
      yield { args: [...initialArgs, ...batch] };
      batch = [];
      batchBytes = getCommandBytes({ command, args: initialArgs });
    } else if (batch.length > 0 && exceedsMaxChars) {
      if (exitIfTooLong && (!itemFitsEmptyBatch || maxArgs !== undefined)) {
        throw new XargsArgumentListTooLongError('xargs: argument line too long');
      }
      yield { args: [...initialArgs, ...batch] };
      batch = [];
      batchBytes = getCommandBytes({ command, args: initialArgs });
    }

    const exceedsEmptyBatch = (maxArgs !== undefined && 1 > maxArgs)
      || batchBytes + itemBytes > maxChars;
    if (batch.length === 0 && exceedsEmptyBatch) {
      throw new XargsArgumentListTooLongError('xargs: argument line too long');
    }

    batch.push(item);
    batchBytes += itemBytes;

  }
  if (batch.length > 0) {
    yield { args: [...initialArgs, ...batch] };
    return;
  }

  if (!sawItem && !noRunIfEmpty) {
    if (getCommandBytes({ command, args: initialArgs }) > maxChars) {
      throw new XargsArgumentListTooLongError('xargs: argument line too long');
    }
    yield { args: [...initialArgs] };
  }
}

function replaceTemplateArgs({
  args,
  placeholder,
  value,
}: {
  args: string[],
  placeholder: string,
  value: string,
}): string[] {
  return args.map((arg) => {
    if (!arg.includes(placeholder)) return arg;
    const replaced = arg.replaceAll(placeholder, value);
    const nulIndex = replaced.indexOf('\0');
    return nulIndex === -1 ? replaced : replaced.slice(0, nulIndex);
  });
}

async function* createReplaceInvocations({
  command,
  items,
  initialArgs,
  placeholder,
  maxChars,
}: {
  command: string,
  items: AsyncIterable<string>,
  initialArgs: readonly string[],
  placeholder: string,
  maxChars: number,
}): AsyncIterable<XargsInvocation> {
  for await (const item of items) {
    // GNU xargs treats an empty -I replacement marker as unbounded when any
    // initial argument would need replacement. The command name itself is not
    // subject to -I replacement, so a command with no initial arguments still
    // runs normally. Defer this until the first input item so -I '' preserves
    // the usual no-run-on-empty-input behavior.
    if (placeholder.length === 0 && initialArgs.length > 0) {
      throw new XargsArgumentListTooLongError('xargs: command too long');
    }

    const args = replaceTemplateArgs({
      args: [...initialArgs],
      placeholder,
      value: item,
    });
    if (getCommandBytes({ command, args }) > maxChars) {
      throw new XargsArgumentListTooLongError('xargs: argument list too long');
    }
    yield {
      args,
    };
  }
}

async function* createLineInvocations({
  command,
  lines,
  initialArgs,
  maxLines,
  maxChars,
  exitIfTooLong,
  noRunIfEmpty,
}: {
  command: string,
  lines: AsyncIterable<string[]>,
  initialArgs: readonly string[],
  maxLines: number,
  maxChars: number,
  exitIfTooLong: boolean,
  noRunIfEmpty: boolean,
}): AsyncIterable<XargsInvocation> {
  let groupedItems: string[] = [];
  let lineCount = 0;
  let sawLine = false;

  const buildInvocation = (): XargsInvocation | undefined => {
    if (groupedItems.length === 0) {
      return undefined;
    }
    const args = [...initialArgs, ...groupedItems];
    if (getCommandBytes({ command, args }) > maxChars && exitIfTooLong) {
      throw new XargsArgumentListTooLongError('xargs: argument list too long');
    }
    groupedItems = [];
    lineCount = 0;
    return { args };
  };

  for await (const lineItems of lines) {
    sawLine = true;
    if (lineCount >= maxLines) {
      const invocation = buildInvocation();
      if (invocation !== undefined) {
        yield invocation;
      }
    }
    for (const item of lineItems) groupedItems.push(item);
    lineCount += 1;
  }

  const invocation = buildInvocation();
  if (invocation !== undefined) {
    yield invocation;
  } else if (!sawLine && !noRunIfEmpty) {
    if (getCommandBytes({ command, args: initialArgs }) > maxChars) {
      throw new XargsArgumentListTooLongError('xargs: argument list too long');
    }
    yield { args: [...initialArgs] };
  }
}

function normalizeXargsExitCode({
  exitCode,
}: {
  exitCode: number,
}): number {
  if (exitCode === 0) return 0;
  if (exitCode === 255) return 124;
  if (exitCode >= 1 && exitCode <= 254) return 123;
  return exitCode;
}

interface XargsCommandResult extends WeshCommandResult {
  readonly launchFailure?: 'notFound',
}

async function runCommand({
  context,
  command,
  args,
  trace,
  stdin,
}: {
  context: WeshCommandContext,
  command: string,
  args: string[],
  trace: boolean,
  stdin: WeshFileHandle,
}): Promise<XargsCommandResult> {
  if (trace) {
    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    await context.text().error({
      text: `${[command, ...args].map((item) => shellQuote({ text: item, characterLocaleMode })).join(' ')}\n`,
    });
  }

  try {
    return await context.executeCommand({
      command,
      args,
      stdin,
      stdout: context.stdout,
      stderr: context.stderr,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Command not found:')) {
      throw error;
    }
    await context.text().error({
      text: `xargs: ${command}: No such file or directory\n`,
    });
    return { exitCode: 127, launchFailure: 'notFound' };
  }
}

async function handleCommandResult({
  context,
  result,
}: {
  context: WeshCommandContext,
  result: XargsCommandResult,
}): Promise<{ kind: 'continue', normalizedExitCode: number } | { kind: 'stop', exitCode: number }> {
  switch (result.launchFailure) {
  case 'notFound':
    return { kind: 'stop', exitCode: 127 };
  case undefined:
    break;
  default: {
    const _ex: never = result.launchFailure;
    throw new Error(`Unhandled xargs launch failure: ${_ex}`);
  }
  }
  if (result.exitCode === 255) {
    await context.text().error({
      text: 'xargs: command exited with status 255; aborting\n',
    });
    return { kind: 'stop', exitCode: 124 };
  }

  return {
    kind: 'continue',
    normalizedExitCode: normalizeXargsExitCode({ exitCode: result.exitCode }),
  };
}

async function executeInvocationStream({
  context,
  command,
  invocations,
  trace,
  stdin,
  maxProcs,
}: {
  context: WeshCommandContext,
  command: string,
  invocations: AsyncIterable<XargsInvocation>,
  trace: boolean,
  stdin: WeshFileHandle,
  maxProcs: number,
}): Promise<WeshCommandResult> {
  const concurrency = maxProcs === 0
    ? MAX_AUTOMATIC_PARALLELISM
    : Math.max(1, maxProcs);
  const active = new Set<Promise<void>>();
  let lastExitCode = 0;
  let stopExitCode: number | undefined;
  let executionError: unknown;

  const startInvocation = ({ invocation }: { invocation: XargsInvocation }): void => {
    const task = (async () => {
      try {
        const result = await runCommand({
          context,
          command,
          args: invocation.args,
          trace,
          stdin,
        });
        const handled = await handleCommandResult({ context, result });
        switch (handled.kind) {
        case 'continue':
          if (handled.normalizedExitCode !== 0) {
            lastExitCode = handled.normalizedExitCode;
          }
          break;
        case 'stop':
          stopExitCode = handled.exitCode;
          break;
        default: {
          const _exhaustive: never = handled;
          throw new Error(`Unhandled xargs command result handling: ${_exhaustive}`);
        }
        }
      } catch (error: unknown) {
        executionError = error;
      }
    })();
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
  };

  try {
    for await (const invocation of invocations) {
      while (active.size >= concurrency) {
        await Promise.race(active);
        if (executionError !== undefined || stopExitCode !== undefined) {
          break;
        }
      }
      if (stopExitCode !== undefined || executionError !== undefined) {
        break;
      }
      startInvocation({ invocation });
    }
  } catch (error: unknown) {
    executionError = error;
  }

  await Promise.all(active);
  if (executionError !== undefined) {
    throw executionError;
  }
  if (stopExitCode !== undefined) {
    return { exitCode: stopExitCode };
  }
  return { exitCode: lastExitCode };
}

export const xargsCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { xargsArgs, commandArgs } = splitXargsArguments({ args: context.args });
    const normalizedXargsArgs = normalizeXargsDeprecatedOptionalShortBundles({
      args: xargsArgs,
    });
    const parsedOwnArguments = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: normalizedXargsArgs,
        spec: xargsArgvSpec,
        earlyExitOptions: STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS,
      }),
      spec: xargsArgvSpec,
    });
    const parsed = {
      ...parsedOwnArguments,
      positionals: commandArgs,
    };

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'xargs',
        message: `xargs: ${diagnostic.message}`,
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'xargs',
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({
        text: `${XARGS_VERSION}\n`,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.showLimits === true) {
      await context.text().print({
        text: `\
Your environment variables take up 0 bytes
POSIX upper limit on argument length (this system): ${DEFAULT_MAX_CHARS}
POSIX smallest allowable upper limit on argument length (all systems): 4096
Maximum length of command we could actually use: ${DEFAULT_MAX_CHARS}
Size of command buffer we are actually using: ${DEFAULT_MAX_CHARS}
Maximum parallelism (--max-procs must be no greater): ${MAX_AUTOMATIC_PARALLELISM}
`,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.interactive === true) {
      await context.text().error({
        text: 'xargs: interactive prompting with --interactive/-p is not supported in wesh yet\n',
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.openTty === true) {
      await context.text().error({
        text: 'xargs: reopening stdin as /dev/tty with --open-tty/-o is not supported in wesh yet\n',
      });
      return { exitCode: 1 };
    }

    const argFileOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'argFile',
    });
    const argFile = typeof argFileOccurrence?.value === 'string' ? argFileOccurrence.value : undefined;
    const executionLimits = await resolveExecutionLimits({
      context,
      occurrences: parsed.occurrences,
    });
    const replaceValue = executionLimits.replaceValue;
    const maxArgs = executionLimits.maxArgs;
    const maxLines = executionLimits.maxLines;
    const maxCharsOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'maxChars',
    });
    const maxChars = typeof maxCharsOccurrence?.value === 'number' ? maxCharsOccurrence.value : DEFAULT_MAX_CHARS;
    const maxProcsOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'maxProcs',
    });
    const maxProcs = typeof maxProcsOccurrence?.value === 'number' ? maxProcsOccurrence.value : 1;
    const inputMode = resolveInputMode({ occurrences: parsed.occurrences });
    const eofOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'eofString',
    });
    const eofString = typeof eofOccurrence?.value === 'string' ? eofOccurrence.value : undefined;

    const [command = 'echo', ...initialArgs] = parsed.positionals;
    const readsItemsFromStdin = argFile === undefined || argFile === '-';
    const childStdin = readsItemsFromStdin
      ? createDevNullLikeHandle()
      : context.stdin;

    try {
      const inputStream = readsItemsFromStdin
        ? openHandleReadStream({ handle: context.stdin })
        : await openFileReadStream({
          files: context.files,
          path: argFile.startsWith('/') ? argFile : `${context.cwd}/${argFile}`,
        });
      const byteChunks = iterateReadableStreamChunks({ stream: inputStream });
      const textChunks = iterateCommandDataTextChunks({ chunks: byteChunks });
      let ignoredNulWarningWritten = false;
      const writeIgnoredNulWarning = async (): Promise<void> => {
        if (ignoredNulWarningWritten) return;
        ignoredNulWarningWritten = true;
        await context.text().error({ text: XARGS_IGNORED_NUL_WARNING });
      };
      let invocations: AsyncIterable<XargsInvocation>;

      if (typeof replaceValue === 'string') {
        const items = (() => {
          switch (inputMode.kind) {
          case 'standard':
            return iterateXargsInsertItems({
              lines: iterateXargsInputLines({
                textChunks: iterateXargsTextIgnoringNulSuffixes({
                  textChunks,
                  boundary: { kind: 'line' },
                  onIgnoredNul: writeIgnoredNulWarning,
                  preserveNul: true,
                }),
              }),
              eofString,
            });
          case 'null':
          case 'delimiter':
            return createExplicitlyDelimitedXargsItems({ textChunks, inputMode });
          default: {
            const _ex: never = inputMode;
            throw new Error(`Unhandled xargs input mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })();
        invocations = createReplaceInvocations({
          command,
          items,
          initialArgs,
          placeholder: replaceValue,
          maxChars,
        });
      } else if (maxLines !== undefined) {
        const lines = (() => {
          switch (inputMode.kind) {
          case 'standard':
            return iterateXargsLogicalLines({
              lines: iterateXargsInputLines({
                textChunks: iterateXargsTextIgnoringNulSuffixes({
                  textChunks,
                  boundary: { kind: 'whitespace' },
                  onIgnoredNul: writeIgnoredNulWarning,
                }),
              }),
            });
          case 'null':
          case 'delimiter':
            return iterateXargsItemsAsLogicalLines({
              items: createExplicitlyDelimitedXargsItems({ textChunks, inputMode }),
            });
          default: {
            const _ex: never = inputMode;
            throw new Error(`Unhandled xargs input mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })();
        invocations = createLineInvocations({
          command,
          lines,
          initialArgs,
          maxLines,
          maxChars,
          exitIfTooLong: true,
          noRunIfEmpty: parsed.optionValues.noRunIfEmpty === true,
        });
      } else {
        const items = (() => {
          switch (inputMode.kind) {
          case 'standard': {
            const filteredTextChunks = iterateXargsTextIgnoringNulSuffixes({
              textChunks,
              boundary: { kind: 'whitespace' },
              onIgnoredNul: writeIgnoredNulWarning,
            });
            return iterateXargsStandardItems({ textChunks: filteredTextChunks, eofString });
          }
          case 'null':
          case 'delimiter':
            return createExplicitlyDelimitedXargsItems({ textChunks, inputMode });
          default: {
            const _ex: never = inputMode;
            throw new Error(`Unhandled xargs input mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })();
        invocations = createBatchedInvocations({
          command,
          items,
          initialArgs,
          maxArgs,
          maxChars,
          exitIfTooLong: parsed.optionValues.exitIfTooLong === true,
          noRunIfEmpty: parsed.optionValues.noRunIfEmpty === true,
        });
      }

      return await executeInvocationStream({
        context,
        command,
        invocations,
        trace: parsed.optionValues.trace === true,
        stdin: childStdin,
        maxProcs,
      });
    } catch (error: unknown) {
      const message = error instanceof XargsInputError
        || error instanceof XargsArgumentListTooLongError
        ? error.message
        : `xargs: ${argFile ?? '-'}: ${error instanceof Error ? error.message : String(error)}`;
      await context.text().error({ text: `${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  normalizeXargsExitCode,
};
