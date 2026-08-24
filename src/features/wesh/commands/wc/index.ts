import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { iterateNullTerminatedPathnames } from '@/features/wesh/commands/_shared/files0-from';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshStat } from '@/features/wesh/types';
import { getWeshCodePointDisplayWidth } from '@/features/wesh/utils/display-width';
import { openHandleReadStream, openFileReadStream } from '@/features/wesh/utils/fs';
import {
  findFirstStandardSemanticIssue,
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';

type WcField = 'lines' | 'words' | 'bytes' | 'chars' | 'maxLineLength';
type WcTotalMode = 'auto' | 'always' | 'only' | 'never';

const WC_TOTAL_MODES: readonly WcTotalMode[] = ['auto', 'always', 'only', 'never'];

interface WcCounts {
  lines: number,
  words: number,
  bytes: number,
  chars: number,
  maxLineLength: number,
}

interface WcEntry {
  name: string | undefined,
  counts: WcCounts,
  byteSizeHint: number | undefined,
}

const EMPTY_WC_COUNTS: WcCounts = {
  lines: 0,
  words: 0,
  bytes: 0,
  chars: 0,
  maxLineLength: 0,
};

function getRegularFileByteSizeHint({ stat }: { stat: WeshStat }): number | undefined {
  switch (stat.type) {
  case 'file':
    return stat.size;
  case 'directory':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return undefined;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled Wesh file type: ${_ex}`);
  }
  }
}

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

const wcArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'l', long: 'lines', effects: [{ key: 'lines', value: true }], help: { summary: 'print newline counts', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'words', effects: [{ key: 'words', value: true }], help: { summary: 'print word counts', category: 'common' } },
    { kind: 'flag', short: 'c', long: 'bytes', effects: [{ key: 'bytes', value: true }], help: { summary: 'print byte counts', category: 'common' } },
    { kind: 'flag', short: 'm', long: 'chars', effects: [{ key: 'chars', value: true }], help: { summary: 'print character counts', category: 'common' } },
    { kind: 'flag', short: 'L', long: 'max-line-length', effects: [{ key: 'maxLineLength', value: true }], help: { summary: 'print the maximum line length', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'files0-from', key: 'files0From', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'read input from NUL-terminated file names in FILE', valueName: 'FILE', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'total', key: 'totalMode', valueName: 'WHEN', allowAttachedValue: false, parseValue: undefined, help: { summary: 'print totals according to WHEN: auto, always, only, or never', valueName: 'WHEN', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isAsciiWhitespaceByte({ byte }: { byte: number }): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

function isWcByteWordSeparator({
  byte,
  posixlyCorrect,
}: {
  byte: number,
  posixlyCorrect: boolean,
}): boolean {
  return isAsciiWhitespaceByte({ byte }) || (!posixlyCorrect && byte === 0xa0);
}

function isWcUnicodeWordSeparator({
  codePoint,
  posixlyCorrect,
}: {
  codePoint: number,
  posixlyCorrect: boolean,
}): boolean {
  if (isAsciiWhitespaceByte({ byte: codePoint })) return true;

  if (
    codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a && codePoint !== 0x2007)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x205f
    || codePoint === 0x3000
  ) {
    return true;
  }

  return !posixlyCorrect && (
    codePoint === 0x00a0
    || codePoint === 0x2007
    || codePoint === 0x202f
    || codePoint === 0x2060
  );
}

function parseWcTotalMode({ value }: { value: string }): WcTotalMode | undefined {
  const matches = WC_TOTAL_MODES.filter(mode => mode.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function findWcPreHelpSemanticIssue({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): string | undefined {
  const value = parsed.optionValues.totalMode;
  return typeof value === 'string' && parseWcTotalMode({ value }) === undefined ? value : undefined;
}

function getSelectedFields({
  optionValues,
}: {
  optionValues: Record<string, boolean | string | number>,
}): WcField[] {
  const fields: WcField[] = [];
  if (optionValues.lines === true) fields.push('lines');
  if (optionValues.words === true) fields.push('words');
  if (optionValues.chars === true) fields.push('chars');
  if (optionValues.bytes === true) fields.push('bytes');
  if (optionValues.maxLineLength === true) fields.push('maxLineLength');

  if (fields.length === 0) {
    return ['lines', 'words', 'bytes'];
  }

  return fields;
}

function getFieldValue({
  counts,
  field,
}: {
  counts: WcCounts,
  field: WcField,
}): number {
  switch (field) {
  case 'lines':
    return counts.lines;
  case 'words':
    return counts.words;
  case 'bytes':
    return counts.bytes;
  case 'chars':
    return counts.chars;
  case 'maxLineLength':
    return counts.maxLineLength;
  default: {
    const _ex: never = field;
    throw new Error(`Unhandled wc field: ${_ex}`);
  }
  }
}

function sumCounts({
  entries,
}: {
  entries: WcEntry[],
}): WcCounts {
  return entries.reduce<WcCounts>((acc, entry) => ({
    lines: acc.lines + entry.counts.lines,
    words: acc.words + entry.counts.words,
    bytes: acc.bytes + entry.counts.bytes,
    chars: acc.chars + entry.counts.chars,
    maxLineLength: Math.max(acc.maxLineLength, entry.counts.maxLineLength),
  }), {
    lines: 0,
    words: 0,
    bytes: 0,
    chars: 0,
    maxLineLength: 0,
  });
}

function computeFieldWidth({
  entries,
  total,
  fields,
  hasRepeatedOrMixedStdin,
}: {
  entries: WcEntry[],
  total: WcCounts | undefined,
  fields: WcField[],
  hasRepeatedOrMixedStdin: boolean,
}): number {
  const totalByteSizeHint = entries.reduce<number | undefined>((sum, entry) => {
    if (sum === undefined || entry.byteSizeHint === undefined) return undefined;
    return sum + entry.byteSizeHint;
  }, 0);
  const hasTotal = total !== undefined;
  const needsSizeBasedWidth = hasTotal || fields.length > 1;
  let width = hasRepeatedOrMixedStdin || (needsSizeBasedWidth && totalByteSizeHint === undefined)
    ? 7
    : needsSizeBasedWidth
      ? String(totalByteSizeHint ?? 0).length
      : 1;

  for (const field of fields) {
    for (const entry of entries) {
      width = Math.max(width, String(getFieldValue({ counts: entry.counts, field })).length);
    }
    if (total !== undefined) {
      width = Math.max(width, String(getFieldValue({ counts: total, field })).length);
    }
  }

  return width;
}

function formatCountsLine({
  counts,
  fields,
  width,
  name,
}: {
  counts: WcCounts,
  fields: WcField[],
  width: number,
  name: string | undefined,
}): string {
  let line = fields
    .map(field => String(getFieldValue({ counts, field })).padStart(width))
    .join(' ');
  if (name !== undefined) {
    line += ` ${name}`;
  }
  return line;
}

function quoteWcOutputName({ name }: { name: string }): string {
  if (!name.includes('\n')) return name;

  const quotePrintable = ({ value }: { value: string }): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  let rendered = name.startsWith('\n') ? "''" : '';
  let index = 0;

  while (index < name.length) {
    if (name[index] === '\n') {
      let end = index + 1;
      while (name[end] === '\n') end += 1;
      rendered += `$'${'\\n'.repeat(end - index)}'`;
      index = end;
      continue;
    }

    let end = index + 1;
    while (end < name.length && name[end] !== '\n') end += 1;
    rendered += quotePrintable({ value: name.slice(index, end) });
    index = end;
  }

  return rendered;
}

function getUtf8SequenceLengthFromLeadByte({
  byte,
}: {
  byte: number,
}): number {
  if (byte >= 0xC2 && byte <= 0xDF) return 2;
  if (byte >= 0xE0 && byte <= 0xEF) return 3;
  if (byte >= 0xF0 && byte <= 0xF7) return 4;
  if (byte >= 0xF8 && byte <= 0xFB) return 5;
  if (byte >= 0xFC && byte <= 0xFD) return 6;
  return 0;
}

function isValidUtf8Continuation({
  leadByte,
  continuationIndex,
  byte,
}: {
  leadByte: number,
  continuationIndex: number,
  byte: number,
}): boolean {
  if (byte < 0x80 || byte > 0xBF) return false;
  if (continuationIndex !== 1) return true;
  if (leadByte === 0xE0) return byte >= 0xA0;
  if (leadByte === 0xED) return byte <= 0x9F;
  if (leadByte === 0xF0) return byte >= 0x90;
  if (leadByte === 0xF8) return byte >= 0x88;
  if (leadByte === 0xFC) return byte >= 0x84;
  return true;
}

const utf8LeadMasks = new Uint8Array([
  0,
  0,
  0x1F,
  0x0F,
  0x07,
  0x03,
  0x01,
]);

function decodeUtf8Sequence({
  bytes,
  length,
}: {
  bytes: Uint8Array,
  length: number,
}): number {
  const firstMask = utf8LeadMasks[length];
  if (firstMask === undefined) {
    throw new Error(`Unhandled UTF-8 sequence length: ${length}`);
  }
  let codePoint = (bytes[0] ?? 0) & firstMask;
  for (let index = 1; index < length; index += 1) {
    codePoint = (codePoint * 64) + ((bytes[index] ?? 0) & 0x3F);
  }
  return codePoint;
}

async function readCountsFromStream({
  stream,
  fields,
  characterLocaleMode,
  posixlyCorrect,
}: {
  stream: ReadableStream<Uint8Array>,
  fields: WcField[],
  characterLocaleMode: WeshCharacterLocaleMode,
  posixlyCorrect: boolean,
}): Promise<WcCounts> {
  const reader = stream.getReader();
  const maxLineLengthUsesDecodedText = fields.includes('maxLineLength')
    && characterLocaleMode === 'unicode';
  const wordCountUsesDecodedText = fields.includes('words')
    && characterLocaleMode === 'unicode';
  const needsUnicodeScalarScan = wordCountUsesDecodedText
    || (fields.includes('chars') && characterLocaleMode === 'unicode')
    || maxLineLengthUsesDecodedText;
  const needsLineCount = fields.includes('lines') || fields.includes('maxLineLength');
  const needsWordCount = fields.includes('words');
  const needsByteCount = fields.includes('bytes');
  const needsCharCount = fields.includes('chars');
  const needsMaxLineLength = fields.includes('maxLineLength');
  let lines = 0;
  let words = 0;
  let bytes = 0;
  let chars = 0;
  let maxLineLength = 0;
  let currentLineLength = 0;
  let inWord = false;

  const consumeCodePoint = ({
    codePoint,
  }: {
    codePoint: number,
  }): void => {
    if (needsCharCount && characterLocaleMode === 'unicode') {
      chars += 1;
    }

    if (codePoint === 0x0A) {
      if (needsLineCount) {
        lines += 1;
      }
      if (needsMaxLineLength) {
        maxLineLength = Math.max(maxLineLength, currentLineLength);
        currentLineLength = 0;
      }
    } else if (maxLineLengthUsesDecodedText) {
      if (codePoint === 0x0D || codePoint === 0x0C) {
        maxLineLength = Math.max(maxLineLength, currentLineLength);
        currentLineLength = 0;
      } else if (codePoint === 0x09) {
        currentLineLength += 8 - (currentLineLength % 8);
      } else {
        currentLineLength += getWeshCodePointDisplayWidth({ codePoint });
      }
    }

    if (needsWordCount) {
      if (isWcUnicodeWordSeparator({ codePoint, posixlyCorrect })) {
        inWord = false;
      } else if (!inWord) {
        inWord = true;
        words += 1;
      }
    }
  };

  const consumeInvalidUtf8Byte = (): void => {
    if (needsWordCount && !inWord) {
      inWord = true;
      words += 1;
    }
  };

  const pendingUtf8Bytes = new Uint8Array(6);
  let pendingUtf8Length = 0;
  let expectedUtf8Length = 0;

  const consumeUnicodeBytes = ({
    chunk,
  }: {
    chunk: Uint8Array,
  }): void => {
    for (const byte of chunk) {
      let shouldReprocess = true;
      while (shouldReprocess) {
        shouldReprocess = false;
        if (pendingUtf8Length === 0) {
          if (byte <= 0x7F) {
            consumeCodePoint({ codePoint: byte });
            continue;
          }
          const sequenceLength = getUtf8SequenceLengthFromLeadByte({ byte });
          if (sequenceLength === 0) {
            consumeInvalidUtf8Byte();
            continue;
          }
          pendingUtf8Bytes[0] = byte;
          pendingUtf8Length = 1;
          expectedUtf8Length = sequenceLength;
          continue;
        }

        if (!isValidUtf8Continuation({
          leadByte: pendingUtf8Bytes[0] ?? 0,
          continuationIndex: pendingUtf8Length,
          byte,
        })) {
          for (let index = 0; index < pendingUtf8Length; index += 1) {
            consumeInvalidUtf8Byte();
          }
          pendingUtf8Length = 0;
          expectedUtf8Length = 0;
          shouldReprocess = true;
          continue;
        }

        pendingUtf8Bytes[pendingUtf8Length] = byte;
        pendingUtf8Length += 1;
        if (pendingUtf8Length === expectedUtf8Length) {
          consumeCodePoint({
            codePoint: decodeUtf8Sequence({
              bytes: pendingUtf8Bytes,
              length: expectedUtf8Length,
            }),
          });
          pendingUtf8Length = 0;
          expectedUtf8Length = 0;
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (needsByteCount) {
        bytes += value.length;
      }
      if (needsCharCount && characterLocaleMode === 'ascii') {
        chars += value.length;
      }
      if (
        characterLocaleMode === 'ascii'
        && (needsLineCount || needsWordCount || needsMaxLineLength)
      ) {
        for (const byte of value) {
          if (byte === 0x0a) {
            if (needsLineCount) {
              lines += 1;
            }
            if (needsMaxLineLength) {
              maxLineLength = Math.max(maxLineLength, currentLineLength);
              currentLineLength = 0;
            }
          } else if (needsMaxLineLength) {
            if (byte === 0x0d || byte === 0x0c) {
              maxLineLength = Math.max(maxLineLength, currentLineLength);
              currentLineLength = 0;
            } else if (byte === 0x09) {
              currentLineLength += 8 - (currentLineLength % 8);
            } else if (byte >= 0x20 && byte <= 0x7e) {
              currentLineLength += 1;
            }
          }

          if (needsWordCount) {
            if (isWcByteWordSeparator({ byte, posixlyCorrect })) {
              inWord = false;
            } else if (!inWord) {
              inWord = true;
              words += 1;
            }
          }
        }
      }
      if (needsUnicodeScalarScan) {
        consumeUnicodeBytes({ chunk: value });
        continue;
      }
      if (needsLineCount && characterLocaleMode === 'unicode') {
        for (const byte of value) {
          if (byte === 0x0a) {
            lines += 1;
          }
        }
      }
    }

    if (needsUnicodeScalarScan) {
      for (let index = 0; index < pendingUtf8Length; index += 1) {
        consumeInvalidUtf8Byte();
      }
      if (maxLineLengthUsesDecodedText) {
        maxLineLength = Math.max(maxLineLength, currentLineLength);
      }
    } else if (needsMaxLineLength) {
      maxLineLength = Math.max(maxLineLength, currentLineLength);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    lines,
    words,
    bytes,
    chars,
    maxLineLength,
  };
}

export const wcCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, byte, character, and line length counts',
    usage: 'wc [OPTION]... [FILE]... | wc [OPTION]... --files0-from=FILE',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: wcArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: wcArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const firstPreHelpSemanticIssue = findFirstStandardSemanticIssue({
      args: parsedArgs,
      spec: wcArgvSpec,
      parsed,
      findSemanticIssue: findWcPreHelpSemanticIssue,
    });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: wcArgvSpec,
      parsed,
      findSemanticIssue: findWcPreHelpSemanticIssue,
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'wc',
        message: `wc: ${diagnostic.message}`,
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (firstPreHelpSemanticIssue !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'wc',
        message: `wc: invalid argument '${firstPreHelpSemanticIssue}' for '--total'`,
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 1 };
    }

    const rawTotalMode = parsed.optionValues.totalMode;
    const totalMode = typeof rawTotalMode === 'string'
      ? parseWcTotalMode({ value: rawTotalMode })
      : 'auto';
    if (totalMode === undefined) {
      throw new Error(`wc pre-help validation missed total mode: ${String(rawTotalMode)}`);
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'wc',
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const selectedFields = getSelectedFields({ optionValues: parsed.optionValues });
    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const posixlyCorrect = context.env.has('POSIXLY_CORRECT');
    const files0FromValue = parsed.optionValues.files0From;
    const files0From = typeof files0FromValue === 'string' ? files0FromValue : undefined;

    if (files0From !== undefined && parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'wc',
        message: `wc: extra operand '${parsed.positionals[0]}'\nfile operands cannot be combined with --files0-from`,
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 1 };
    }

    const entries: WcEntry[] = [];
    let hadError = false;
    let requestedInputCount = 0;
    let hasDataStdinOperand = false;

    const processInput = async ({ inputName }: { inputName: string | undefined }): Promise<void> => {
      if (inputName === undefined || inputName === '-') {
        hasDataStdinOperand = true;
        const counts = await readCountsFromStream({
          stream: openHandleReadStream({ handle: context.stdin }),
          fields: selectedFields,
          characterLocaleMode,
          posixlyCorrect,
        });
        entries.push({
          name: inputName,
          counts,
          byteSizeHint: undefined,
        });
        return;
      }

      try {
        const fullPath = resolveInputPath({ cwd: context.cwd, path: inputName });
        const stat = await context.files.stat({ path: fullPath });
        switch (stat.type) {
        case 'directory':
          entries.push({
            name: inputName,
            counts: { ...EMPTY_WC_COUNTS },
            byteSizeHint: undefined,
          });
          hadError = true;
          await text.error({ text: `wc: ${inputName}: Is a directory\n` });
          return;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          break;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled Wesh file type: ${_ex}`);
        }
        }
        const counts = await readCountsFromStream({
          stream: await openFileReadStream({
            files: context.files,
            path: fullPath,
          }),
          fields: selectedFields,
          characterLocaleMode,
          posixlyCorrect,
        });
        entries.push({
          name: inputName,
          counts,
          byteSizeHint: getRegularFileByteSizeHint({ stat }),
        });
      } catch (e: unknown) {
        hadError = true;
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `wc: ${inputName}: ${message}\n` });
      }
    };

    if (files0From === undefined) {
      const inputNames = parsed.positionals.length === 0 ? [undefined] : parsed.positionals;
      requestedInputCount = inputNames.length;
      for (const inputName of inputNames) {
        await processInput({ inputName });
      }
    } else {
      try {
        for await (const record of iterateNullTerminatedPathnames({ context, source: files0From })) {
          requestedInputCount += 1;
          if (record.value.length === 0) {
            hadError = true;
            await text.error({
              text: `wc: ${files0From}:${record.sourceRecordNumber}: invalid zero-length file name\n`,
            });
            continue;
          }
          if (files0From === '-' && record.value === '-') {
            hadError = true;
            await text.error({
              text: "wc: when reading file names from stdin, no file name of '-' allowed\n",
            });
            continue;
          }
          await processInput({ inputName: record.value });
        }
      } catch (e: unknown) {
        hadError = true;
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `wc: cannot open '${files0From}' for reading: ${message}\n` });
      }
    }

    const shouldPrintTotal = (() => {
      switch (totalMode) {
      case 'auto': return requestedInputCount > 1 && entries.length > 0;
      case 'always':
      case 'only':
        return true;
      case 'never': return false;
      default: {
        const _ex: never = totalMode;
        throw new Error(`Unhandled wc total mode: ${_ex}`);
      }
      }
    })();
    const total = shouldPrintTotal ? sumCounts({ entries }) : undefined;
    const totalPresentation = (() => {
      switch (totalMode) {
      case 'auto':
      case 'always':
      case 'never':
        return { showEntries: true, forceNaturalWidth: false, totalName: 'total' } as const;
      case 'only':
        return { showEntries: false, forceNaturalWidth: true, totalName: undefined } as const;
      default: {
        const _ex: never = totalMode;
        throw new Error(`Unhandled wc total presentation mode: ${_ex}`);
      }
      }
    })();
    const widthSizingTotal = requestedInputCount > 1
      ? (total ?? sumCounts({ entries }))
      : total;
    const showNames = files0From !== undefined || parsed.positionals.length > 0;
    const width = files0From === '-' || totalPresentation.forceNaturalWidth
      ? 1
      : computeFieldWidth({
        entries,
        total: widthSizingTotal,
        fields: selectedFields,
        hasRepeatedOrMixedStdin: requestedInputCount > 1 && hasDataStdinOperand,
      });

    if (totalPresentation.showEntries) {
      for (const entry of entries) {
        await text.print({
          text: `${formatCountsLine({
            counts: entry.counts,
            fields: selectedFields,
            width,
            name: showNames && entry.name !== undefined
              ? quoteWcOutputName({ name: entry.name })
              : undefined,
          })}
`,
        });
      }
    }

    if (total !== undefined) {
      await text.print({
        text: `${formatCountsLine({
          counts: total,
          fields: selectedFields,
          width,
          name: totalPresentation.totalName,
        })}
`,
      });
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
