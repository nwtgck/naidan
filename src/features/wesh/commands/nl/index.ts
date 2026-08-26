import { parseStandardArgv, type ArgvDiagnostic, type ParsedStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { decodeCommandDataBytes } from '@/features/wesh/commands/_shared/data-codec';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { compileBasicRegularExpression } from '@/features/wesh/commands/_shared/posix-regexp';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/features/wesh/types';
import { openHandleReadStream, openFileReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

type NlSection = 'header' | 'body' | 'footer';

type NlNumberingStyle =
  | { kind: 'all' }
  | { kind: 'nonempty' }
  | { kind: 'none' }
  | {
      kind: 'pattern',
      pattern: string,
      regex: RegExp,
      characterLocaleMode: WeshCharacterLocaleMode,
    };

type NlNumberFormat = 'ln' | 'rn' | 'rz';

interface NlLineRecord {
  lineBytes: Uint8Array,
}

interface NlOptions {
  bodyStyle: NlNumberingStyle,
  headerStyle: NlNumberingStyle,
  footerStyle: NlNumberingStyle,
  sectionDelimiter: Uint8Array | undefined,
  increment: number,
  joinBlankLines: number,
  format: NlNumberFormat,
  noRenumber: boolean,
  separator: string,
  startingLineNumber: number,
  width: number,
}

interface NlState {
  section: NlSection,
  lineNumber: number,
  blankRunLength: number,
}

const textEncoder = new TextEncoder();
const lineFeedByte = 0x0a;
const NL_MAX_NUMBER_WIDTH = 1_000_000;

function resolveInputPath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function parseIntegerOption({
  value,
  label,
  minimum,
}: {
  value: string,
  label: string,
  minimum: number | undefined,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^[+-]?\d+$/.test(numericText)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  if (minimum !== undefined && parsed < minimum) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseNumberWidth({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const parsed = parseIntegerOption({
    value,
    label: 'line number field width',
    minimum: 1,
  });
  if (!parsed.ok || parsed.value <= NL_MAX_NUMBER_WIDTH) return parsed;
  return {
    ok: false,
    message: `line number field width exceeds safety limit ${NL_MAX_NUMBER_WIDTH}`,
  };
}

const nlArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'b', long: 'body-numbering', key: 'bodyNumbering', valueName: 'STYLE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use STYLE for numbering body lines', valueName: 'STYLE', category: 'common' } },
    { kind: 'value', short: 'd', long: 'section-delimiter', key: 'sectionDelimiter', valueName: 'CC', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use CC for logical page delimiters', valueName: 'CC', category: 'advanced' } },
    { kind: 'value', short: 'f', long: 'footer-numbering', key: 'footerNumbering', valueName: 'STYLE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use STYLE for numbering footer lines', valueName: 'STYLE', category: 'advanced' } },
    { kind: 'value', short: 'h', long: 'header-numbering', key: 'headerNumbering', valueName: 'STYLE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use STYLE for numbering header lines', valueName: 'STYLE', category: 'advanced' } },
    { kind: 'value', short: 'i', long: 'line-increment', key: 'increment', valueName: 'NUMBER', allowAttachedValue: true, parseValue: ({ value }) => parseIntegerOption({ value, label: 'line number increment', minimum: undefined }), help: { summary: 'line number increment at each numbered line', valueName: 'NUMBER', category: 'common' } },
    { kind: 'value', short: 'l', long: 'join-blank-lines', key: 'joinBlankLines', valueName: 'NUMBER', allowAttachedValue: true, parseValue: ({ value }) => parseIntegerOption({ value, label: 'line number of blank lines', minimum: 0 }), help: { summary: 'group NUMBER empty lines as one numbered line', valueName: 'NUMBER', category: 'advanced' } },
    { kind: 'value', short: 'n', long: 'number-format', key: 'numberFormat', valueName: 'FORMAT', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use FORMAT for line numbers: ln, rn, or rz', valueName: 'FORMAT', category: 'common' } },
    { kind: 'flag', short: 'p', long: 'no-renumber', effects: [{ key: 'noRenumber', value: true }], help: { summary: 'do not reset line numbers at logical pages', category: 'advanced' } },
    { kind: 'value', short: 's', long: 'number-separator', key: 'separator', valueName: 'STRING', allowAttachedValue: true, parseValue: undefined, help: { summary: 'add STRING after each line number', valueName: 'STRING', category: 'common' } },
    { kind: 'value', short: 'v', long: 'starting-line-number', key: 'startingLineNumber', valueName: 'NUMBER', allowAttachedValue: true, parseValue: ({ value }) => parseIntegerOption({ value, label: 'starting line number', minimum: undefined }), help: { summary: 'first line number on each logical page', valueName: 'NUMBER', category: 'common' } },
    { kind: 'value', short: 'w', long: 'number-width', key: 'numberWidth', valueName: 'NUMBER', allowAttachedValue: true, parseValue: ({ value }) => parseNumberWidth({ value }), help: { summary: 'use NUMBER columns for line numbers', valueName: 'NUMBER', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};


interface ParsedNlArgv {
  readonly parsed: ParsedStandardArgv,
  readonly parsedArgs: string[],
  readonly helpMode: 'normal' | 'after-unknown-options',
}

function isUnknownOptionDiagnostic({
  diagnostic,
}: {
  diagnostic: ArgvDiagnostic,
}): boolean {
  switch (diagnostic.kind) {
  case 'unknown_short_option':
  case 'unknown_long_option':
    return true;
  case 'missing_option_value':
  case 'invalid_option_value':
    return false;
  default: {
    const _ex: never = diagnostic.kind;
    throw new Error(`Unhandled nl argv diagnostic kind: ${_ex}`);
  }
  }
}

function parseNlArgv({
  args,
}: {
  args: string[],
}): ParsedNlArgv {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--help') continue;

    const parsedPrefix = parseStandardArgv({
      args: args.slice(0, index + 1),
      spec: nlArgvSpec,
    });
    if (
      parsedPrefix.optionValues.help === true
      && parsedPrefix.diagnostics.every((diagnostic) => isUnknownOptionDiagnostic({ diagnostic }))
    ) {
      return {
        parsed: parsedPrefix,
        parsedArgs: args.slice(0, index + 1),
        helpMode: parsedPrefix.diagnostics.length === 0 ? 'normal' : 'after-unknown-options',
      };
    }
  }

  return {
    parsed: parseStandardArgv({ args, spec: nlArgvSpec }),
    parsedArgs: args,
    helpMode: 'normal',
  };
}

function parseNumberingStyle({
  value,
  label,
  characterLocaleMode,
}: {
  value: string,
  label: string,
  characterLocaleMode: WeshCharacterLocaleMode,
}): { ok: true, style: NlNumberingStyle } | { ok: false, message: string } {
  switch (value) {
  case 'a':
    return { ok: true, style: { kind: 'all' } };
  case 't':
    return { ok: true, style: { kind: 'nonempty' } };
  case 'n':
    return { ok: true, style: { kind: 'none' } };
  default:
    if (!value.startsWith('p')) {
      return { ok: false, message: `invalid ${label}: '${value}'` };
    }

    try {
      return {
        ok: true,
        style: {
          kind: 'pattern',
          pattern: value.slice(1),
          regex: compileBasicRegularExpression({
            source: value.slice(1),
            flags: '',
            characterClassMode: characterLocaleMode,
            gnuWordOperators: true,
            basicOperatorMode: 'gnu',
            dotMode: 'non-newline',
            excludeSurrogateEscapes: false,
          }),
          characterLocaleMode,
        },
      };
    } catch {
      return { ok: false, message: 'invalid regular expression' };
    }
  }
}

function parseNumberFormat({
  value,
}: {
  value: string,
}): { ok: true, format: NlNumberFormat } | { ok: false, message: string } {
  switch (value) {
  case 'ln':
  case 'rn':
  case 'rz':
    return { ok: true, format: value };
  default:
    return { ok: false, message: `invalid line numbering format: '${value}'` };
  }
}

interface NlPreHelpSemanticDiagnostic {
  readonly message: string,
  readonly fatal: boolean,
}

function collectNlPreHelpSemanticDiagnostics({
  parsed,
  characterLocaleMode,
}: {
  parsed: ParsedStandardArgv,
  characterLocaleMode: WeshCharacterLocaleMode,
}): readonly NlPreHelpSemanticDiagnostic[] {
  const diagnostics: NlPreHelpSemanticDiagnostic[] = [];

  for (const occurrence of parsed.occurrences) {
    if (occurrence.kind !== 'value' || typeof occurrence.value !== 'string') continue;

    const styleLabel = (() => {
      switch (occurrence.key) {
      case 'bodyNumbering':
        return 'body numbering style';
      case 'footerNumbering':
        return 'footer numbering style';
      case 'headerNumbering':
        return 'header numbering style';
      default:
        return undefined;
      }
    })();

    if (styleLabel !== undefined) {
      const style = parseNumberingStyle({
        value: occurrence.value,
        label: styleLabel,
        characterLocaleMode,
      });
      if (!style.ok) {
        diagnostics.push({
          message: style.message,
          fatal: style.message === 'invalid regular expression',
        });
        if (style.message === 'invalid regular expression') break;
      }
      continue;
    }

    if (occurrence.key === 'numberFormat') {
      const format = parseNumberFormat({ value: occurrence.value });
      if (!format.ok) diagnostics.push({ message: format.message, fatal: false });
    }
  }

  return diagnostics;
}

interface NlOrderedPreHelpDiagnostic {
  readonly message: string,
  readonly fatal: boolean,
}

function collectNlMixedPreHelpDiagnosticsInArgvOrder({
  args,
  characterLocaleMode,
}: {
  args: string[],
  characterLocaleMode: WeshCharacterLocaleMode,
}): readonly NlOrderedPreHelpDiagnostic[] {
  const ordered: NlOrderedPreHelpDiagnostic[] = [];
  let unknownCount = 0;
  let semanticCount = 0;

  for (let end = 1; end <= args.length; end += 1) {
    const parsedPrefix = parseStandardArgv({ args: args.slice(0, end), spec: nlArgvSpec });
    const unknownDiagnostics = parsedPrefix.diagnostics.filter((diagnostic) => (
      isUnknownOptionDiagnostic({ diagnostic })
    ));
    const semanticDiagnostics = collectNlPreHelpSemanticDiagnostics({
      parsed: parsedPrefix,
      characterLocaleMode,
    });

    for (; unknownCount < unknownDiagnostics.length; unknownCount += 1) {
      const diagnostic = unknownDiagnostics[unknownCount];
      if (diagnostic !== undefined) ordered.push({ message: diagnostic.message, fatal: false });
    }
    for (; semanticCount < semanticDiagnostics.length; semanticCount += 1) {
      const diagnostic = semanticDiagnostics[semanticCount];
      if (diagnostic === undefined) continue;
      ordered.push(diagnostic);
      if (diagnostic.fatal) return ordered;
    }
  }

  return ordered;
}

function parseSectionDelimiter({
  value,
}: {
  value: string,
}): Uint8Array | undefined {
  if (value.length === 0) {
    return undefined;
  }

  const delimiter = value.length === 1 ? `${value}:` : value;
  return textEncoder.encode(delimiter);
}

function getStringOption({
  value,
  fallback,
}: {
  value: boolean | string | number | undefined,
  fallback: string,
}): string {
  return typeof value === 'string' ? value : fallback;
}

function getNumberOption({
  value,
  fallback,
}: {
  value: boolean | string | number | undefined,
  fallback: number,
}): number {
  return typeof value === 'number' ? value : fallback;
}

function buildOptions({
  optionValues,
  characterLocaleMode,
}: {
  optionValues: Record<string, boolean | string | number>,
  characterLocaleMode: WeshCharacterLocaleMode,
}): { ok: true, options: NlOptions } | { ok: false, message: string } {
  const bodyStyle = parseNumberingStyle({
    value: getStringOption({ value: optionValues.bodyNumbering, fallback: 't' }),
    label: 'body numbering style',
    characterLocaleMode,
  });
  if (!bodyStyle.ok) return { ok: false, message: bodyStyle.message };

  const headerStyle = parseNumberingStyle({
    value: getStringOption({ value: optionValues.headerNumbering, fallback: 'n' }),
    label: 'header numbering style',
    characterLocaleMode,
  });
  if (!headerStyle.ok) return { ok: false, message: headerStyle.message };

  const footerStyle = parseNumberingStyle({
    value: getStringOption({ value: optionValues.footerNumbering, fallback: 'n' }),
    label: 'footer numbering style',
    characterLocaleMode,
  });
  if (!footerStyle.ok) return { ok: false, message: footerStyle.message };

  const format = parseNumberFormat({
    value: getStringOption({ value: optionValues.numberFormat, fallback: 'rn' }),
  });
  if (!format.ok) return { ok: false, message: format.message };

  const joinBlankLines = getNumberOption({ value: optionValues.joinBlankLines, fallback: 1 });

  return {
    ok: true,
    options: {
      bodyStyle: bodyStyle.style,
      headerStyle: headerStyle.style,
      footerStyle: footerStyle.style,
      sectionDelimiter: parseSectionDelimiter({
        value: getStringOption({ value: optionValues.sectionDelimiter, fallback: '\\:' }),
      }),
      increment: getNumberOption({ value: optionValues.increment, fallback: 1 }),
      joinBlankLines: joinBlankLines === 0 ? 1 : joinBlankLines,
      format: format.format,
      noRenumber: optionValues.noRenumber === true,
      separator: getStringOption({ value: optionValues.separator, fallback: '\t' }),
      startingLineNumber: getNumberOption({ value: optionValues.startingLineNumber, fallback: 1 }),
      width: getNumberOption({ value: optionValues.numberWidth, fallback: 6 }),
    },
  };
}

function concatenateChunks({
  chunks,
  totalLength,
}: {
  chunks: Uint8Array[],
  totalLength: number,
}): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array();
  }

  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array();
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function* iterateNlLineRecords({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncGenerator<NlLineRecord> {
  let pending: Uint8Array[] = [];
  let pendingLength = 0;

  for await (const chunk of chunks) {
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== lineFeedByte) {
        continue;
      }

      const segment = chunk.subarray(segmentStart, index);
      if (segment.length > 0) {
        pending.push(segment);
        pendingLength += segment.length;
      }

      yield {
        lineBytes: concatenateChunks({ chunks: pending, totalLength: pendingLength }),
      };

      pending = [];
      pendingLength = 0;
      segmentStart = index + 1;
    }

    if (segmentStart < chunk.length) {
      const tail = chunk.subarray(segmentStart);
      pending.push(tail);
      pendingLength += tail.length;
    }
  }

  if (pendingLength > 0) {
    yield {
      lineBytes: concatenateChunks({ chunks: pending, totalLength: pendingLength }),
    };
  }
}

async function writeAllBytesToHandle({
  handle,
  bytes,
}: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let totalWritten = 0;
  while (totalWritten < bytes.length) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset: totalWritten,
      length: bytes.length - totalWritten,
    });
    if (bytesWritten === 0) {
      return;
    }
    totalWritten += bytesWritten;
  }
}

function createBufferedBinaryWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle,
  maxBufferLength: number,
}) {
  let chunks: Uint8Array[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const bytes = concatenateChunks({
      chunks,
      totalLength: bufferedLength,
    });
    chunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({ handle, bytes });
  };

  const writeBytes = async ({
    bytes,
  }: {
    bytes: Uint8Array,
  }): Promise<void> => {
    if (bytes.length === 0) {
      return;
    }

    chunks.push(bytes);
    bufferedLength += bytes.length;
    if (bufferedLength < maxBufferLength) {
      return;
    }

    await flush();
  };

  const writeText = async ({
    text,
  }: {
    text: string,
  }): Promise<void> => {
    await writeBytes({ bytes: textEncoder.encode(text) });
  };

  return { writeBytes, writeText, flush };
}

function matchesRepeatedBytes({
  lineBytes,
  delimiter,
  count,
}: {
  lineBytes: Uint8Array,
  delimiter: Uint8Array,
  count: number,
}): boolean {
  if (lineBytes.length !== delimiter.length * count) {
    return false;
  }

  for (let index = 0; index < lineBytes.length; index++) {
    const expected = delimiter[index % delimiter.length];
    if (expected === undefined || lineBytes[index] !== expected) {
      return false;
    }
  }

  return true;
}

function classifySectionDelimiter({
  lineBytes,
  delimiter,
}: {
  lineBytes: Uint8Array,
  delimiter: Uint8Array | undefined,
}): NlSection | undefined {
  if (delimiter === undefined || delimiter.length === 0) {
    return undefined;
  }

  if (matchesRepeatedBytes({ lineBytes, delimiter, count: 3 })) {
    return 'header';
  }

  if (matchesRepeatedBytes({ lineBytes, delimiter, count: 2 })) {
    return 'body';
  }

  if (matchesRepeatedBytes({ lineBytes, delimiter, count: 1 })) {
    return 'footer';
  }

  return undefined;
}

function getNumberingStyleForSection({
  section,
  options,
}: {
  section: NlSection,
  options: NlOptions,
}): NlNumberingStyle {
  switch (section) {
  case 'header':
    return options.headerStyle;
  case 'body':
    return options.bodyStyle;
  case 'footer':
    return options.footerStyle;
  default: {
    const _ex: never = section;
    throw new Error(`Unhandled nl section: ${_ex}`);
  }
  }
}

function decodeSingleByteCharacters({
  bytes,
}: {
  bytes: Uint8Array,
}): string {
  const parts: string[] = [];
  const chunkLength = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkLength) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkLength)));
  }
  return parts.join('');
}

function testUnicodePattern({
  regex,
  lineBytes,
}: {
  regex: RegExp,
  lineBytes: Uint8Array,
}): boolean {
  const decoded = decodeCommandDataBytes({ bytes: lineBytes });
  const input = decoded.replace(/[\udc80-\udcff]/gu, '\n');
  const flags = regex.flags.replaceAll('y', '').includes('g')
    ? regex.flags.replaceAll('y', '')
    : `${regex.flags.replaceAll('y', '')}g`;
  const matcher = new RegExp(regex.source, flags);
  let match = matcher.exec(input);
  while (match !== null) {
    if (!match[0].includes('\n')) {
      return true;
    }
    const codePoint = input.codePointAt(match.index);
    matcher.lastIndex = match.index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
    match = matcher.exec(input);
  }
  return false;
}

function testPattern({
  style,
  lineBytes,
}: {
  style: Extract<NlNumberingStyle, { kind: 'pattern' }>,
  lineBytes: Uint8Array,
}): boolean {
  switch (style.characterLocaleMode) {
  case 'ascii':
    return style.regex.test(decodeSingleByteCharacters({ bytes: lineBytes }));
  case 'unicode':
    return testUnicodePattern({ regex: style.regex, lineBytes });
  default: {
    const _ex: never = style.characterLocaleMode;
    throw new Error(`Unhandled nl character locale mode: ${_ex}`);
  }
  }
}

function shouldNumberLine({
  lineBytes,
  options,
  state,
}: {
  lineBytes: Uint8Array,
  options: NlOptions,
  state: NlState,
}): boolean {
  const style = getNumberingStyleForSection({
    section: state.section,
    options,
  });
  const isEmpty = lineBytes.length === 0;

  switch (style.kind) {
  case 'all':
    if (!isEmpty) {
      state.blankRunLength = 0;
      return true;
    }
    state.blankRunLength += 1;
    return state.blankRunLength % options.joinBlankLines === 0;
  case 'nonempty':
    state.blankRunLength = isEmpty ? state.blankRunLength + 1 : 0;
    return !isEmpty;
  case 'none':
    return false;
  case 'pattern':
    state.blankRunLength = isEmpty ? state.blankRunLength + 1 : 0;
    return testPattern({ style, lineBytes });
  default: {
    const _ex: never = style;
    throw new Error(`Unhandled nl numbering style: ${JSON.stringify(_ex)}`);
  }
  }
}

function formatLineNumber({
  value,
  width,
  format,
}: {
  value: number,
  width: number,
  format: NlNumberFormat,
}): string {
  const text = String(value);
  switch (format) {
  case 'ln':
    return text.padEnd(width, ' ');
  case 'rn':
    return text.padStart(width, ' ');
  case 'rz': {
    if (text.startsWith('-')) {
      return `-${text.slice(1).padStart(Math.max(width - 1, 0), '0')}`;
    }
    return text.padStart(width, '0');
  }
  default: {
    const _ex: never = format;
    throw new Error(`Unhandled nl number format: ${_ex}`);
  }
  }
}

function getUnnumberedPrefix({
  options,
}: {
  options: NlOptions,
}): string {
  const separatorWidth = textEncoder.encode(options.separator).length;
  return ' '.repeat(options.width + separatorWidth);
}

async function writeOutputLine({
  writer,
  lineBytes,
  shouldNumber,
  options,
  state,
}: {
  writer: ReturnType<typeof createBufferedBinaryWriter>,
  lineBytes: Uint8Array,
  shouldNumber: boolean,
  options: NlOptions,
  state: NlState,
}): Promise<void> {
  if (shouldNumber) {
    await writer.writeText({
      text: `${formatLineNumber({ value: state.lineNumber, width: options.width, format: options.format })}${options.separator}`,
    });
    state.lineNumber += options.increment;
  } else {
    await writer.writeText({ text: getUnnumberedPrefix({ options }) });
  }

  await writer.writeBytes({ bytes: lineBytes });
  await writer.writeBytes({ bytes: new Uint8Array([lineFeedByte]) });
}

async function processStream({
  stream,
  options,
  state,
  writer,
}: {
  stream: ReadableStream<Uint8Array>,
  options: NlOptions,
  state: NlState,
  writer: ReturnType<typeof createBufferedBinaryWriter>,
}): Promise<void> {
  for await (const record of iterateNlLineRecords({
    chunks: iterateReadableStreamChunks({ stream }),
  })) {
    const nextSection = classifySectionDelimiter({
      lineBytes: record.lineBytes,
      delimiter: options.sectionDelimiter,
    });

    if (nextSection !== undefined) {
      state.section = nextSection;
      if (!options.noRenumber) {
        state.lineNumber = options.startingLineNumber;
      }
      await writer.writeBytes({ bytes: new Uint8Array([lineFeedByte]) });
      continue;
    }

    await writeOutputLine({
      writer,
      lineBytes: record.lineBytes,
      shouldNumber: shouldNumberLine({ lineBytes: record.lineBytes, options, state }),
      options,
      state,
    });
  }
}

function shouldForwardSignal({
  context,
}: {
  context: WeshCommandContext,
}): boolean {
  const waitStatus = context.process.getWaitStatus();
  if (waitStatus === undefined) return false;

  switch (waitStatus.kind) {
  case 'signaled':
    return true;
  case 'exited':
  case 'stopped':
    return false;
  default: {
    const _ex: never = waitStatus;
    throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
  }
  }
}

export const nlCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'nl',
    description: 'Number lines of files',
    usage: 'nl [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgv = parseNlArgv({ args: context.args });
    const { parsed, parsedArgs, helpMode } = parsedArgv;

    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });

    switch (helpMode) {
    case 'after-unknown-options': {
      const orderedDiagnostics = collectNlMixedPreHelpDiagnosticsInArgvOrder({
        args: parsedArgs,
        characterLocaleMode,
      });
      for (const diagnostic of orderedDiagnostics) {
        await context.text().error({ text: `nl: ${diagnostic.message}\n` });
        if (diagnostic.fatal) return { exitCode: 1 };
      }
      await writeCommandHelp({
        context,
        command: 'nl',
        argvSpec: nlArgvSpec,
      });
      return { exitCode: 0 };
    }
    case 'normal':
      break;
    default: {
      const _ex: never = helpMode;
      throw new Error(`Unhandled nl help mode: ${_ex}`);
    }
    }

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'nl',
        message: `nl: ${diagnostic.message}`,
        argvSpec: nlArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      const semanticDiagnostics = collectNlPreHelpSemanticDiagnostics({
        parsed,
        characterLocaleMode,
      });
      for (const semanticDiagnostic of semanticDiagnostics) {
        await context.text().error({ text: `nl: ${semanticDiagnostic.message}\n` });
        if (semanticDiagnostic.fatal) return { exitCode: 1 };
      }
      await writeCommandHelp({
        context,
        command: 'nl',
        argvSpec: nlArgvSpec,
      });
      return { exitCode: 0 };
    }

    const builtOptions = buildOptions({
      optionValues: parsed.optionValues,
      characterLocaleMode,
    });
    if (!builtOptions.ok) {
      await writeCommandUsageError({
        context,
        command: 'nl',
        message: `nl: ${builtOptions.message}`,
        argvSpec: nlArgvSpec,
      });
      return { exitCode: 1 };
    }

    const writer = createBufferedBinaryWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    const files = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    const state: NlState = {
      section: 'body',
      lineNumber: builtOptions.options.startingLineNumber,
      blankRunLength: 0,
    };
    let hadError = false;

    try {
      for (const file of files) {
        if (file === '-') {
          await processStream({
            stream: openHandleReadStream({ handle: context.stdin }),
            options: builtOptions.options,
            state,
            writer,
          });
          continue;
        }

        try {
          await processStream({
            stream: await openFileReadStream({
              files: context.files,
              path: resolveInputPath({ cwd: context.cwd, path: file }),
            }),
            options: builtOptions.options,
            state,
            writer,
          });
        } catch (error: unknown) {
          if (shouldForwardSignal({ context })) {
            throw error;
          }
          await writer.flush();
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `nl: ${file}: ${message}\n` });
          hadError = true;
        }
      }
    } finally {
      await writer.flush();
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
