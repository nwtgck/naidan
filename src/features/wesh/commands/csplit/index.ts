import { parseStandardArgv, type ArgvValue, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { decodeCommandDataBytes, decodeCommandDataBytesAsSingleByte } from '@/features/wesh/commands/_shared/data-codec';
import { compileBasicRegularExpression } from '@/features/wesh/commands/_shared/posix-regexp';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { writeAllStreamToFile } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

interface CsplitOptions {
  prefix: string,
  digits: number,
  suffixFormat: string | undefined,
  keepFiles: boolean,
  silent: boolean,
  elideEmptyFiles: boolean,
  suppressMatched: boolean,
}

interface CsplitLineRecord {
  bytes: Uint8Array,
  matchText: string,
}

type CsplitPattern =
  | { kind: 'line', lineNumber: number, source: string }
  | { kind: 'regex', delimiter: '/' | '%', regex: RegExp, offset: number, source: string };

type CsplitParsedToken =
  | { kind: 'pattern', pattern: CsplitPattern }
  | { kind: 'repeat', count: number | 'until-exhausted', source: string };

interface CsplitSection {
  mode: 'write' | 'skip',
  startLineIndex: number,
  endLineIndexExclusive: number,
}

interface CsplitPlan {
  sections: CsplitSection[],
  warnings: string[],
  errorMessage: string | undefined,
}

type CsplitPatternApplicationResult = 'applied' | 'exhausted' | 'error';

interface SuffixConversion {
  start: number,
  end: number,
  zeroPad: boolean,
  width: number | undefined,
  conversion: 'd' | 'i' | 'u' | 'o' | 'x' | 'X',
}

function parsePositiveInteger({
  value,
  description,
}: {
  value: string,
  description: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { ok: false, message: `${description} must be a positive integer: '${value}'` };
  }

  const parsed = Number.parseInt(numericText, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `${description} must be a positive integer: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseNonNegativeInteger({
  value,
  description,
}: {
  value: string,
  description: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { ok: false, message: `${description} must be a non-negative integer: '${value}'` };
  }

  const parsed = Number.parseInt(numericText, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, message: `${description} must be a non-negative integer: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseDigitsOption({
  value,
}: {
  value: string,
}): { ok: true, value: ArgvValue } | { ok: false, message: string } {
  return parseNonNegativeInteger({ value, description: 'number of digits' });
}

const csplitArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'f',
      long: 'prefix',
      key: 'prefix',
      valueName: 'prefix',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use PREFIX instead of xx', valueName: 'PREFIX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'b',
      long: 'suffix-format',
      key: 'suffixFormat',
      valueName: 'format',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use printf-style FORMAT instead of %02d', valueName: 'FORMAT', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'digits',
      key: 'digits',
      valueName: 'digits',
      allowAttachedValue: true,
      parseValue: parseDigitsOption,
      help: { summary: 'use DIGITS digits in numeric suffixes', valueName: 'DIGITS', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'k',
      long: 'keep-files',
      effects: [{ key: 'keepFiles', value: true }],
      help: { summary: 'do not remove output files on errors', category: 'common' },
    },
    {
      kind: 'flag',
      short: 's',
      long: 'silent',
      effects: [{ key: 'silent', value: true }],
      help: { summary: 'do not print output file sizes', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'q',
      long: 'quiet',
      effects: [{ key: 'silent', value: true }],
      help: { summary: 'do not print output file sizes', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'z',
      long: 'elide-empty-files',
      effects: [{ key: 'elideEmptyFiles', value: true }],
      help: { summary: 'remove empty output files', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'suppress-matched',
      effects: [{ key: 'suppressMatched', value: true }],
      help: { summary: 'suppress the lines matching PATTERN', category: 'common' },
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
  specialTokenParsers: [],
};

function parseOptions({
  values,
}: {
  values: Record<string, ArgvValue>,
}): CsplitOptions {
  return {
    prefix: typeof values.prefix === 'string' ? values.prefix : 'xx',
    digits: typeof values.digits === 'number' ? values.digits : 2,
    suffixFormat: typeof values.suffixFormat === 'string' ? values.suffixFormat : undefined,
    keepFiles: values.keepFiles === true,
    silent: values.silent === true,
    elideEmptyFiles: values.elideEmptyFiles === true,
    suppressMatched: values.suppressMatched === true,
  };
}

function isEscapedAt({
  value,
  index,
}: {
  value: string,
  index: number,
}): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function parseOffset({
  value,
}: {
  value: string,
}): number | undefined {
  if (value === '') {
    return 0;
  }
  if (!/^[+-]?\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseDelimitedRegexPattern({
  token,
  delimiter,
  characterLocaleMode,
}: {
  token: string,
  delimiter: '/' | '%',
  characterLocaleMode: WeshCharacterLocaleMode,
}): CsplitPattern | undefined {
  if (!token.startsWith(delimiter)) {
    return undefined;
  }

  let closingIndex = -1;
  for (let index = 1; index < token.length; index += 1) {
    if (token[index] === delimiter && !isEscapedAt({ value: token, index })) {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex < 0) {
    throw new Error(`invalid pattern '${token}': missing closing '${delimiter}'`);
  }

  const body = token.slice(1, closingIndex);
  const offsetText = token.slice(closingIndex + 1);
  const offset = parseOffset({ value: offsetText });
  if (offset === undefined) {
    throw new Error(`invalid offset in pattern '${token}'`);
  }

  try {
    return {
      kind: 'regex',
      delimiter,
      regex: compileBasicRegularExpression({
        source: body,
        flags: '',
        characterClassMode: characterLocaleMode,
        gnuWordOperators: true,
        basicOperatorMode: 'gnu',
        dotMode: 'non-null',
        excludeSurrogateEscapes: characterLocaleMode === 'unicode',
      }),
      offset,
      source: token,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid regular expression '${token}': ${message}`);
  }
}

function parseCsplitToken({
  token,
  characterLocaleMode,
}: {
  token: string,
  characterLocaleMode: WeshCharacterLocaleMode,
}): CsplitParsedToken {
  const repeatMatch = /^\{(\+?\d+|\*)\}$/u.exec(token);
  if (repeatMatch !== null) {
    const rawCount = repeatMatch[1];
    if (rawCount === undefined) {
      throw new Error(`invalid repeat pattern '${token}'`);
    }
    if (rawCount === '*') {
      return { kind: 'repeat', count: 'until-exhausted', source: token };
    }
    const repeatCount = parseNonNegativeInteger({
      value: rawCount,
      description: 'repeat count',
    });
    if (!repeatCount.ok) {
      throw new Error(`invalid repeat pattern '${token}': ${repeatCount.message}`);
    }
    return { kind: 'repeat', count: repeatCount.value, source: token };
  }

  const slashPattern = parseDelimitedRegexPattern({
    token,
    delimiter: '/',
    characterLocaleMode,
  });
  if (slashPattern !== undefined) {
    return { kind: 'pattern', pattern: slashPattern };
  }

  const percentPattern = parseDelimitedRegexPattern({
    token,
    delimiter: '%',
    characterLocaleMode,
  });
  if (percentPattern !== undefined) {
    return { kind: 'pattern', pattern: percentPattern };
  }

  const lineNumber = parsePositiveInteger({ value: token, description: 'line number' });
  if (!lineNumber.ok) {
    throw new Error(`invalid pattern '${token}'`);
  }

  return {
    kind: 'pattern',
    pattern: { kind: 'line', lineNumber: lineNumber.value, source: token },
  };
}

async function readAllInputBytes({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of iterateReadableStreamChunks({
    stream: await openCommandInputStream({ context, input }),
  })) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function decodeCsplitMatchBytes({
  bytes,
  characterLocaleMode,
}: {
  bytes: Uint8Array,
  characterLocaleMode: WeshCharacterLocaleMode,
}): string {
  switch (characterLocaleMode) {
  case 'ascii':
    return decodeCommandDataBytesAsSingleByte({ bytes });
  case 'unicode':
    return decodeCommandDataBytes({ bytes });
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled character locale mode: ${_ex}`);
  }
  }
}

function splitIntoLineRecords({
  bytes,
  characterLocaleMode,
}: {
  bytes: Uint8Array,
  characterLocaleMode: WeshCharacterLocaleMode,
}): CsplitLineRecord[] {
  const records: CsplitLineRecord[] = [];
  let start = 0;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }

    const lineBytes = bytes.slice(start, index + 1);
    records.push({
      bytes: lineBytes,
      matchText: decodeCsplitMatchBytes({
        bytes: lineBytes.subarray(0, lineBytes.byteLength - 1),
        characterLocaleMode,
      }),
    });
    start = index + 1;
  }

  if (start < bytes.byteLength) {
    const lineBytes = bytes.slice(start);
    records.push({
      bytes: lineBytes,
      matchText: decodeCsplitMatchBytes({ bytes: lineBytes, characterLocaleMode }),
    });
  }

  return records;
}

function findRegexMatch({
  lines,
  regex,
  startLineIndex,
}: {
  lines: CsplitLineRecord[],
  regex: RegExp,
  startLineIndex: number,
}): number | undefined {
  for (let index = startLineIndex; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[index]?.matchText ?? '')) {
      return index;
    }
  }
  return undefined;
}

function linePatternBoundary({
  currentLineIndex,
  pattern,
  isRepetition,
  suppressMatched,
}: {
  currentLineIndex: number,
  pattern: Extract<CsplitPattern, { kind: 'line' }>,
  isRepetition: boolean,
  suppressMatched: boolean,
}): number {
  if (isRepetition) {
    return currentLineIndex + pattern.lineNumber - (suppressMatched ? 1 : 0);
  }
  return pattern.lineNumber - 1;
}

function sectionModeForRegexDelimiter({
  delimiter,
}: {
  delimiter: '/' | '%',
}): CsplitSection['mode'] {
  switch (delimiter) {
  case '/':
    return 'write';
  case '%':
    return 'skip';
  default: {
    const _ex: never = delimiter;
    throw new Error(`Unhandled csplit regex delimiter: ${_ex}`);
  }
  }
}

function appendFinalWriteSection({
  sections,
  currentLineIndex,
  lines,
}: {
  sections: CsplitSection[],
  currentLineIndex: number,
  lines: CsplitLineRecord[],
}): void {
  sections.push({
    mode: 'write',
    startLineIndex: currentLineIndex,
    endLineIndexExclusive: lines.length,
  });
}

function validateAbsoluteLinePatternOrder({
  parsedTokens,
}: {
  parsedTokens: readonly CsplitParsedToken[],
}): { warnings: string[], errorMessage: string | undefined } {
  const warnings: string[] = [];
  let precedingLineNumber: number | undefined;

  for (const parsedToken of parsedTokens) {
    if (parsedToken.kind !== 'pattern' || parsedToken.pattern.kind !== 'line') {
      continue;
    }
    const { lineNumber, source } = parsedToken.pattern;
    if (precedingLineNumber !== undefined) {
      if (lineNumber < precedingLineNumber) {
        return {
          warnings,
          errorMessage: `csplit: line number '${source}' is smaller than preceding line number, ${precedingLineNumber}`,
        };
      }
      if (lineNumber === precedingLineNumber) {
        warnings.push(`csplit: warning: line number '${source}' is the same as preceding line number`);
      }
    }
    precedingLineNumber = lineNumber;
  }

  return { warnings, errorMessage: undefined };
}

function computeSections({
  lines,
  patternTokens,
  suppressMatched,
  characterLocaleMode,
}: {
  lines: CsplitLineRecord[],
  patternTokens: string[],
  suppressMatched: boolean,
  characterLocaleMode: WeshCharacterLocaleMode,
}): CsplitPlan {
  const parsedTokens: CsplitParsedToken[] = [];
  for (const token of patternTokens) {
    try {
      parsedTokens.push(parseCsplitToken({ token, characterLocaleMode }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { sections: [], warnings: [], errorMessage: `csplit: ${message}` };
    }
  }

  const orderValidation = validateAbsoluteLinePatternOrder({ parsedTokens });
  if (orderValidation.errorMessage !== undefined) {
    return {
      sections: [],
      warnings: orderValidation.warnings,
      errorMessage: orderValidation.errorMessage,
    };
  }

  const sections: CsplitSection[] = [];
  let currentLineIndex = 0;
  let nextRegexSearchLineIndex = 0;
  let previousPattern: CsplitPattern | undefined;
  let errorMessage: string | undefined;

  const applyPattern = ({
    pattern,
    isRepetition,
    repetitionIndex,
    allowRegexExhaustion,
  }: {
    pattern: CsplitPattern,
    isRepetition: boolean,
    repetitionIndex: number | undefined,
    allowRegexExhaustion: boolean,
  }): CsplitPatternApplicationResult => {
    switch (pattern.kind) {
    case 'line': {
      const boundary = linePatternBoundary({
        currentLineIndex,
        pattern,
        isRepetition,
        suppressMatched,
      });
      const followsRegex = !isRepetition && previousPattern?.kind === 'regex';
      if (followsRegex && boundary <= currentLineIndex) {
        sections.push({
          mode: 'write',
          startLineIndex: currentLineIndex,
          endLineIndexExclusive: currentLineIndex,
        });
        const cannotAdvance = suppressMatched
          ? currentLineIndex >= lines.length
          : currentLineIndex >= lines.length - 1;
        if (cannotAdvance) {
          errorMessage = `csplit: '${pattern.source}': line number out of range`;
          return 'error';
        }
        if (suppressMatched) {
          currentLineIndex += 1;
        }
        nextRegexSearchLineIndex = Math.max(
          nextRegexSearchLineIndex,
          suppressMatched ? currentLineIndex : currentLineIndex + 1,
        );
        return 'applied';
      }

      const maximumBoundary = suppressMatched ? lines.length : lines.length - 1;
      const suppressAtEofWithoutProgress = suppressMatched
        && boundary === lines.length
        && boundary === currentLineIndex;
      if (
        boundary < currentLineIndex
        || boundary > maximumBoundary
        || suppressAtEofWithoutProgress
      ) {
        errorMessage = repetitionIndex === undefined
          ? `csplit: '${pattern.source}': line number out of range`
          : `csplit: '${pattern.source}': line number out of range on repetition ${repetitionIndex}`;
        const suppressingRegexMatchedAtEnd = suppressMatched
          && previousPattern?.kind === 'regex'
          && nextRegexSearchLineIndex >= lines.length;
        if (suppressingRegexMatchedAtEnd) {
          sections.push({
            mode: 'write',
            startLineIndex: currentLineIndex,
            endLineIndexExclusive: currentLineIndex,
          });
        } else {
          appendFinalWriteSection({ sections, currentLineIndex, lines });
        }
        return 'error';
      }
      sections.push({
        mode: 'write',
        startLineIndex: currentLineIndex,
        endLineIndexExclusive: boundary,
      });
      currentLineIndex = boundary;
      if (suppressMatched && currentLineIndex < lines.length) {
        currentLineIndex += 1;
      }
      nextRegexSearchLineIndex = Math.max(nextRegexSearchLineIndex, currentLineIndex);
      return 'applied';
    }
    case 'regex': {
      const regexSearchStartLineIndex = Math.max(currentLineIndex, nextRegexSearchLineIndex);
      const matchedLineIndex = findRegexMatch({
        lines,
        regex: pattern.regex,
        startLineIndex: regexSearchStartLineIndex,
      });
      if (matchedLineIndex === undefined) {
        if (allowRegexExhaustion) {
          return 'exhausted';
        }
        errorMessage = `csplit: '${pattern.source}': match not found`;
        sections.push({
          mode: sectionModeForRegexDelimiter({ delimiter: pattern.delimiter }),
          startLineIndex: currentLineIndex,
          endLineIndexExclusive: lines.length,
        });
        return 'error';
      }

      nextRegexSearchLineIndex = matchedLineIndex + 1;
      const boundary = matchedLineIndex + pattern.offset;
      if (boundary < currentLineIndex || boundary > lines.length) {
        errorMessage = `csplit: '${pattern.source}': line number out of range`;
        sections.push({
          mode: sectionModeForRegexDelimiter({ delimiter: pattern.delimiter }),
          startLineIndex: currentLineIndex,
          endLineIndexExclusive: Math.min(Math.max(boundary, currentLineIndex), lines.length),
        });
        return 'error';
      }

      sections.push({
        mode: sectionModeForRegexDelimiter({ delimiter: pattern.delimiter }),
        startLineIndex: currentLineIndex,
        endLineIndexExclusive: boundary,
      });
      currentLineIndex = boundary;
      if (suppressMatched && currentLineIndex < lines.length) {
        currentLineIndex += 1;
        nextRegexSearchLineIndex = Math.max(nextRegexSearchLineIndex, currentLineIndex);
      }
      return 'applied';
    }
    default: {
      const _ex: never = pattern;
      throw new Error(`Unhandled csplit pattern: ${JSON.stringify(_ex)}`);
    }
    }
  };

  parsedTokenLoop:
  for (let parsedIndex = 0; parsedIndex < parsedTokens.length; parsedIndex += 1) {
    const parsed = parsedTokens[parsedIndex];
    if (parsed === undefined) {
      throw new Error(`Missing csplit parsed token at index ${parsedIndex}`);
    }
    switch (parsed.kind) {
    case 'pattern': {
      const nextParsed = parsedTokens[parsedIndex + 1];
      const result = applyPattern({
        pattern: parsed.pattern,
        isRepetition: false,
        repetitionIndex: undefined,
        allowRegexExhaustion: parsed.pattern.kind === 'regex'
          && nextParsed?.kind === 'repeat'
          && nextParsed.count === 'until-exhausted',
      });
      previousPattern = parsed.pattern;
      switch (result) {
      case 'applied':
        break;
      case 'error':
        return { sections, warnings: orderValidation.warnings, errorMessage };
      case 'exhausted':
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled csplit pattern result: ${_ex}`);
      }
      }
      break;
    }
    case 'repeat': {
      if (previousPattern === undefined) {
        return {
          sections,
          warnings: orderValidation.warnings,
          errorMessage: `csplit: '${parsed.source}': repeat pattern has no previous pattern`,
        };
      }

      if (parsed.count === 'until-exhausted') {
        for (let repetitionIndex = 1; ; repetitionIndex += 1) {
          const result = applyPattern({
            pattern: previousPattern,
            isRepetition: true,
            repetitionIndex,
            allowRegexExhaustion: previousPattern.kind === 'regex',
          });
          switch (result) {
          case 'applied':
            break;
          case 'exhausted':
            break parsedTokenLoop;
          case 'error':
            return { sections, warnings: orderValidation.warnings, errorMessage };
          default: {
            const _ex: never = result;
            throw new Error(`Unhandled csplit pattern result: ${_ex}`);
          }
          }
        }
        break;
      }

      for (let index = 1; index <= parsed.count; index += 1) {
        const result = applyPattern({
          pattern: previousPattern,
          isRepetition: true,
          repetitionIndex: index,
          allowRegexExhaustion: false,
        });
        switch (result) {
        case 'applied':
          break;
        case 'error':
          return { sections, warnings: orderValidation.warnings, errorMessage };
        case 'exhausted':
          break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled csplit pattern result: ${_ex}`);
        }
        }
      }
      break;
    }
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled csplit token: ${JSON.stringify(_ex)}`);
    }
    }
  }

  appendFinalWriteSection({ sections, currentLineIndex, lines });
  return { sections, warnings: orderValidation.warnings, errorMessage: undefined };
}

function parseSuffixFormat({
  format,
}: {
  format: string,
}): SuffixConversion | undefined {
  let conversion: SuffixConversion | undefined;

  for (let index = 0; index < format.length; index += 1) {
    if (format[index] !== '%') {
      continue;
    }
    if (format[index + 1] === '%') {
      index += 1;
      continue;
    }
    if (conversion !== undefined) {
      throw new Error('invalid suffix format: must contain exactly one integer conversion');
    }

    let cursor = index + 1;
    let zeroPad = false;
    if (format[cursor] === '0') {
      zeroPad = true;
      cursor += 1;
    }

    let widthText = '';
    while (/\d/u.test(format[cursor] ?? '')) {
      widthText += format[cursor];
      cursor += 1;
    }

    const conversionText = format[cursor];
    if (conversionText !== 'd'
      && conversionText !== 'i'
      && conversionText !== 'u'
      && conversionText !== 'o'
      && conversionText !== 'x'
      && conversionText !== 'X') {
      throw new Error('invalid suffix format: must contain exactly one integer conversion');
    }

    const parsedWidth = widthText === '' ? undefined : Number.parseInt(widthText, 10);
    if (parsedWidth !== undefined && !Number.isSafeInteger(parsedWidth)) {
      throw new Error('invalid suffix format: width is too large');
    }

    conversion = {
      start: index,
      end: cursor + 1,
      zeroPad,
      width: parsedWidth,
      conversion: conversionText,
    };
    index = cursor;
  }

  if (conversion === undefined) {
    throw new Error('invalid suffix format: must contain exactly one integer conversion');
  }

  return conversion;
}

function formatSuffixValue({
  value,
  conversion,
}: {
  value: number,
  conversion: SuffixConversion,
}): string {
  const raw = (() => {
    switch (conversion.conversion) {
    case 'd':
    case 'i':
    case 'u':
      return String(value);
    case 'o':
      return value.toString(8);
    case 'x':
      return value.toString(16);
    case 'X':
      return value.toString(16).toUpperCase();
    default: {
      const _ex: never = conversion.conversion;
      throw new Error(`Unhandled suffix conversion: ${_ex}`);
    }
    }
  })();

  const width = conversion.width ?? 0;
  if (raw.length >= width) {
    return raw;
  }
  const padChar = conversion.zeroPad ? '0' : ' ';
  return `${padChar.repeat(width - raw.length)}${raw}`;
}

function formatOutputFileName({
  options,
  outputIndex,
  suffixConversion,
}: {
  options: CsplitOptions,
  outputIndex: number,
  suffixConversion: SuffixConversion | undefined,
}): string {
  if (options.suffixFormat === undefined) {
    return `${options.prefix}${String(outputIndex).padStart(options.digits, '0')}`;
  }

  if (suffixConversion === undefined) {
    throw new Error('suffix conversion must be parsed before formatting output names');
  }

  const suffix = options.suffixFormat.slice(0, suffixConversion.start)
    + formatSuffixValue({ value: outputIndex, conversion: suffixConversion })
    + options.suffixFormat.slice(suffixConversion.end);
  return `${options.prefix}${suffix.replaceAll('%%', '%')}`;
}

function createSectionStream({
  lines,
  section,
}: {
  lines: CsplitLineRecord[],
  section: CsplitSection,
}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = section.startLineIndex; index < section.endLineIndexExclusive; index += 1) {
        const line = lines[index];
        if (line !== undefined) {
          controller.enqueue(line.bytes);
        }
      }
      controller.close();
    },
  });
}

function sectionByteLength({
  lines,
  section,
}: {
  lines: CsplitLineRecord[],
  section: CsplitSection,
}): number {
  let byteLength = 0;
  for (let index = section.startLineIndex; index < section.endLineIndexExclusive; index += 1) {
    byteLength += lines[index]?.bytes.byteLength ?? 0;
  }
  return byteLength;
}

async function handleDirectoryInput({
  context,
  input,
  options,
  suffixConversion,
}: {
  context: WeshCommandContext,
  input: string,
  options: CsplitOptions,
  suffixConversion: SuffixConversion | undefined,
}): Promise<WeshCommandResult | undefined> {
  if (input === '-') return undefined;

  try {
    const stat = await context.files.stat({ path: resolvePath({ cwd: context.cwd, path: input }) });
    switch (stat.type) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return undefined;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled csplit input type: ${_ex}`);
    }
    }
  } catch {
    return undefined;
  }

  const createdPaths = await writeSections({
    context,
    lines: [],
    sections: [{ mode: 'write', startLineIndex: 0, endLineIndexExclusive: 0 }],
    options,
    suffixConversion,
  });
  if (!options.keepFiles) {
    await cleanupCreatedFiles({ context, paths: createdPaths });
  }
  await context.text().error({ text: 'csplit: read error: Is a directory\n' });
  return { exitCode: 1 };
}

async function cleanupCreatedFiles({
  context,
  paths,
}: {
  context: WeshCommandContext,
  paths: string[],
}): Promise<void> {
  for (const path of paths.slice().reverse()) {
    try {
      await context.files.unlink({ path });
    } catch {
      // Cleanup best effort mirrors csplit's user-facing behavior: report the original error.
    }
  }
}

async function writeSections({
  context,
  lines,
  sections,
  options,
  suffixConversion,
}: {
  context: WeshCommandContext,
  lines: CsplitLineRecord[],
  sections: CsplitSection[],
  options: CsplitOptions,
  suffixConversion: SuffixConversion | undefined,
}): Promise<string[]> {
  const createdPaths: string[] = [];
  const stdout = createBufferedTextWriter({ handle: context.stdout, maxBufferLength: 4096 });
  let outputIndex = 0;

  try {
    for (const section of sections) {
      switch (section.mode) {
      case 'skip':
        continue;
      case 'write':
        break;
      default: {
        const _ex: never = section.mode;
        throw new Error(`Unhandled csplit section mode: ${_ex}`);
      }
      }

      const byteLength = sectionByteLength({ lines, section });
      if (options.elideEmptyFiles && byteLength === 0) {
        continue;
      }

      const fileName = formatOutputFileName({
        options,
        outputIndex,
        suffixConversion,
      });
      outputIndex += 1;
      const path = resolvePath({ cwd: context.cwd, path: fileName });
      createdPaths.push(path);
      await writeAllStreamToFile({
        files: context.files,
        path,
        stream: createSectionStream({ lines, section }),
        mode: 'truncate',
      });

      if (!options.silent) {
        await stdout.write({ text: `${byteLength}\n` });
      }
    }
  } catch (error: unknown) {
    if (!options.keepFiles) {
      await cleanupCreatedFiles({ context, paths: createdPaths });
    }
    throw error;
  } finally {
    await stdout.flush();
  }

  return createdPaths;
}

export const csplitCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: csplitArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: csplitArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'csplit',
        message: `csplit: ${diagnostic.message}`,
        argvSpec: csplitArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'csplit',
        argvSpec: csplitArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'csplit',
        message: 'csplit: missing file operand',
        argvSpec: csplitArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 1) {
      await writeCommandUsageError({
        context,
        command: 'csplit',
        message: 'csplit: missing pattern operand',
        argvSpec: csplitArgvSpec,
      });
      return { exitCode: 1 };
    }

    const [input, ...patternTokens] = parsed.positionals;
    if (input === undefined) {
      throw new Error('csplit input must be present after operand validation');
    }

    const options = parseOptions({ values: parsed.optionValues });
    let suffixConversion: SuffixConversion | undefined;
    try {
      suffixConversion = options.suffixFormat === undefined
        ? undefined
        : parseSuffixFormat({ format: options.suffixFormat });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await writeCommandUsageError({
        context,
        command: 'csplit',
        message: `csplit: ${message}`,
        argvSpec: csplitArgvSpec,
      });
      return { exitCode: 1 };
    }

    try {
      const directoryResult = await handleDirectoryInput({
        context,
        input,
        options,
        suffixConversion,
      });
      if (directoryResult !== undefined) return directoryResult;

      const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
      const lines = splitIntoLineRecords({
        bytes: await readAllInputBytes({ context, input }),
        characterLocaleMode,
      });
      const plan = computeSections({
        lines,
        patternTokens,
        suppressMatched: options.suppressMatched,
        characterLocaleMode,
      });
      for (const warning of plan.warnings) {
        await context.text().error({ text: `${warning}\n` });
      }
      const createdPaths = await writeSections({
        context,
        lines,
        sections: plan.sections,
        options,
        suffixConversion,
      });

      if (plan.errorMessage !== undefined) {
        if (!options.keepFiles) {
          await cleanupCreatedFiles({ context, paths: createdPaths });
        }
        await context.text().error({ text: `${plan.errorMessage}\n` });
        return { exitCode: 1 };
      }

      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({
        text: `csplit: ${input === '-' ? 'standard input' : input}: ${message}\n`,
      });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
