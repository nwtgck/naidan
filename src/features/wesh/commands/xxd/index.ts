import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
} from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { XxdOperandError, withXxdOperandError } from './errors';
import { reverseXxd } from './reverse';

const MAX_SIGNED_64_BIT_INTEGER = (1n << 63n) - 1n;
const MAX_COLUMNS = 256;

function parseNonNegativeBigInt({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: bigint } | { ok: false, message: string } {
  const normalized = value.trim();
  if (!/^(?:0[xX][0-9a-fA-F]+|0[0-7]+|\d+)$/u.test(normalized)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = /^0[xX]/u.test(normalized)
    ? BigInt(normalized)
    : /^0[0-7]+$/u.test(normalized) && normalized !== '0'
      ? BigInt(`0o${normalized.slice(1)}`)
      : BigInt(normalized);
  if (parsed > MAX_SIGNED_64_BIT_INTEGER) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseSignedBigInt({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: bigint } | { ok: false, message: string } {
  const normalized = value.trim();
  const match = /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]+|\d+)$/u.exec(normalized);
  if (match === null) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const magnitudeText = match[2]!;
  const magnitude = /^0[xX]/u.test(magnitudeText)
    ? BigInt(magnitudeText)
    : /^0[0-7]+$/u.test(magnitudeText) && magnitudeText !== '0'
      ? BigInt(`0o${magnitudeText.slice(1)}`)
      : BigInt(magnitudeText);
  if (magnitude > MAX_SIGNED_64_BIT_INTEGER) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }
  return { ok: true, value: sign * magnitude };
}

function parseDecimalNonNegativeInteger({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }
  const parsed = BigInt(normalized);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }
  return { ok: true, value: Number(parsed) };
}

function toHex({
  value,
  uppercase,
  width,
}: {
  value: number,
  uppercase: boolean,
  width: number | undefined,
}): string {
  const raw = value.toString(16);
  const formatted = width === undefined ? raw : raw.padStart(width, '0');
  return uppercase ? formatted.toUpperCase() : formatted;
}

function renderAscii({
  bytes,
}: {
  bytes: Uint8Array,
}): string {
  let result = '';
  for (const byte of bytes) {
    result += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
  }
  return result;
}

function getHexColumnWidth({
  columns,
  groupSize,
}: {
  columns: number,
  groupSize: number,
}): number {
  let width = 0;
  let remaining = columns;
  while (remaining > 0) {
    const bytesInGroup = Math.min(groupSize, remaining);
    width += bytesInGroup * 2;
    remaining -= bytesInGroup;
    if (remaining > 0) {
      width += 1;
    }
  }
  return width;
}

function renderHexSection({
  bytes,
  columns,
  groupSize,
  uppercase,
}: {
  bytes: Uint8Array,
  columns: number,
  groupSize: number,
  uppercase: boolean,
}): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += groupSize) {
    const group = bytes.slice(index, index + groupSize);
    parts.push(Array.from(group, (byte) => toHex({ value: byte, uppercase, width: 2 })).join(''));
  }
  return parts.join(' ').padEnd(getHexColumnWidth({ columns, groupSize }), ' ');
}

function renderDisplayOffset({
  value,
  uppercase,
}: {
  value: bigint,
  uppercase: boolean,
}): string {
  const unsigned = value < 0n ? BigInt.asUintN(64, value) : value;
  const raw = unsigned.toString(16).padStart(8, '0');
  return uppercase ? raw.toUpperCase() : raw;
}

function renderNormalLine({
  bytes,
  columns,
  groupSize,
  uppercase,
  displayOffset,
}: {
  bytes: Uint8Array,
  columns: number,
  groupSize: number,
  uppercase: boolean,
  displayOffset: bigint,
}): string {
  return `${renderDisplayOffset({ value: displayOffset, uppercase })}: ${renderHexSection({
    bytes,
    columns,
    groupSize,
    uppercase,
  })}  ${renderAscii({ bytes })}\n`;
}

function renderPlainLine({
  bytes,
  uppercase,
}: {
  bytes: Uint8Array,
  uppercase: boolean,
}): string {
  return `${Array.from(bytes, byte => toHex({
    value: byte,
    uppercase,
    width: 2,
  })).join('')}\n`;
}

async function* iterateXxdRows({
  stream,
  columns,
  seek,
  length,
}: {
  stream: ReadableStream<Uint8Array>,
  columns: number,
  seek: number,
  length: bigint | undefined,
}): AsyncIterable<Uint8Array> {
  let bytesToSkip = seek;
  let bytesRemaining = length;
  let pending = new Uint8Array(columns);
  let pendingLength = 0;

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let start = 0;
    if (bytesToSkip > 0) {
      const skipped = Math.min(bytesToSkip, chunk.byteLength);
      bytesToSkip -= skipped;
      start += skipped;
    }
    if (start >= chunk.byteLength) {
      continue;
    }

    const remainingInChunk = chunk.byteLength - start;
    const availableLength = bytesRemaining === undefined
      ? remainingInChunk
      : Number(bytesRemaining < BigInt(remainingInChunk) ? bytesRemaining : BigInt(remainingInChunk));
    const end = start + availableLength;
    if (bytesRemaining !== undefined) {
      bytesRemaining -= BigInt(availableLength);
    }

    while (start < end) {
      if (pendingLength === 0 && end - start >= columns) {
        yield chunk.subarray(start, start + columns);
        start += columns;
        continue;
      }

      const copied = Math.min(columns - pendingLength, end - start);
      pending.set(chunk.subarray(start, start + copied), pendingLength);
      pendingLength += copied;
      start += copied;
      if (pendingLength === columns) {
        yield pending;
        pending = new Uint8Array(columns);
        pendingLength = 0;
      }
    }

    if (bytesRemaining === 0n) {
      break;
    }
  }

  if (pendingLength > 0) {
    yield pending.subarray(0, pendingLength);
  }
}

type XxdOption = 'autoskip' | 'help' | 'plain' | 'reverse' | 'uppercase'
  | 'columns' | 'groupSize' | 'length' | 'displayOffset' | 'seek';

const xxdOptions = [
  {
    semantic: 'autoskip',
    forms: [{ kind: 'short', name: 'a', value: { kind: 'none' } }],
    summary: 'replace repeated nul lines with *',
    category: 'common',
  },
  {
    semantic: 'columns',
    forms: [{ kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'cols' } }],
    summary: 'set the number of octets per line',
    valueName: 'COLS',
    category: 'common',
  },
  {
    semantic: 'groupSize',
    forms: [{ kind: 'short', name: 'g', value: { kind: 'required-attached-or-following', missingValueName: 'bytes' } }],
    summary: 'group output by BYTES octets',
    valueName: 'BYTES',
    category: 'common',
  },
  {
    semantic: 'help',
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'help', value: { kind: 'none' } },
    ],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: 'length',
    forms: [{ kind: 'short', name: 'l', value: { kind: 'required-attached-or-following', missingValueName: 'len' } }],
    summary: 'stop after LEN octets',
    valueName: 'LEN',
    category: 'common',
  },
  {
    semantic: 'displayOffset',
    forms: [{ kind: 'short', name: 'o', value: { kind: 'required-attached-or-following', missingValueName: 'offset' } }],
    summary: 'add OFFSET to displayed positions',
    valueName: 'OFFSET',
    category: 'common',
  },
  {
    semantic: 'plain',
    forms: [
      { kind: 'short', name: 'p', value: { kind: 'none' } },
      { kind: 'long', name: 'ps', value: { kind: 'none' } },
    ],
    summary: 'output in plain hexdump style',
    category: 'common',
  },
  {
    semantic: 'reverse',
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'revert', value: { kind: 'none' } },
    ],
    summary: 'convert a hex dump back to binary',
    category: 'common',
  },
  {
    semantic: 'seek',
    forms: [{ kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'seek' } }],
    summary: 'start at SEEK bytes',
    valueName: 'SEEK',
    category: 'common',
  },
  {
    semantic: 'uppercase',
    forms: [{ kind: 'short', name: 'u', value: { kind: 'none' } }],
    summary: 'use upper-case hex letters',
    category: 'common',
  },
] as const;

const xxdArgvCatalog = defineArgvCatalog<XxdOption>({
  definitions: xxdOptions,
  nonExecutableLongOptions: [],
});
const xxdArgvHelp = defineArgvHelpPresentation({ catalog: xxdArgvCatalog, rows: xxdOptions });

function parseXxdArgv({ args }: { args: readonly string[] }):
  | { readonly kind: 'parsed', readonly optionValues: Partial<Record<XxdOption, string | true>>, readonly positionals: readonly string[] }
  | { readonly kind: 'invalid', readonly message: string } {
  const optionValues: Partial<Record<XxdOption, string | true>> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const long = token.startsWith('--');
    const plainAlias = token === '-ps' || token === '-plain' || token === '-postscript';
    const shortToken = plainAlias ? '-p' : token;
    const analysis = long
      ? analyzeArgvLongForm({ token, catalog: xxdArgvCatalog, longNameMatch: 'exact' })
      : analyzeArgvShortForm({ token: shortToken, bodyOffset: 1, prefix: '-', catalog: xxdArgvCatalog });
    switch (analysis.kind) {
    case 'unknown':
      return {
        kind: 'invalid',
        message: long ? `unrecognized option '${analysis.option}'` : `invalid option -- '${analysis.option.slice(1)}'`,
      };
    case 'ambiguous':
      throw new Error('xxd only supports exact long option names');
    case 'matched': {
      const { semantic, value } = analysis;
      switch (value.kind) {
      case 'none':
      case 'unexpected-inline':
        optionValues[semantic] = true;
        // Preserve the established xxd operand boundary for non-bundled short flags.
        if (!long && shortToken.length > 2) {
          positionals.push(`-${shortToken.slice(2)}`);
        }
        break;
      case 'inline':
        optionValues[semantic] = value.rawValue;
        break;
      case 'following-required': {
        const following = args[index + 1];
        if (following === undefined) {
          return { kind: 'invalid', message: `${analysis.option} requires a value for ${value.valueName}` };
        }
        optionValues[semantic] = following;
        index += 1;
        break;
      }
      case 'following-optional':
        throw new Error(`xxd option '${analysis.option}' has unexpected optional-value syntax`);
      default: {
        const _ex: never = value;
        throw new Error(`Unhandled xxd option value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    default: {
      const _ex: never = analysis;
      throw new Error(`Unhandled xxd option analysis: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { kind: 'parsed', optionValues, positionals };
}


export const xxdCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseXxdArgv({ args: context.args });
    switch (parsed.kind) {
    case 'invalid':
      await writeCommandUsageError({
        context,
        command: 'xxd',
        message: `xxd: ${parsed.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: xxdArgvHelp }),
      });
      return { exitCode: 1 };
    case 'parsed':
      break;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled xxd argv parse result: ${JSON.stringify(_ex)}`);
    }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'xxd',
        optionLines: formatArgvOptionHelp({ presentation: xxdArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'xxd',
        message: 'xxd: extra operand',
        usageSummary: formatArgvUsageSummary({ presentation: xxdArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const columnsRaw = parsed.optionValues.columns as string | undefined;
    const groupSizeRaw = parsed.optionValues.groupSize as string | undefined;
    const lengthRaw = parsed.optionValues.length as string | undefined;
    const seekRaw = parsed.optionValues.seek as string | undefined;
    const displayOffsetRaw = parsed.optionValues.displayOffset as string | undefined;

    const defaultColumns = parsed.optionValues.plain === true ? 30 : 16;
    const columnsParsedRaw = parseDecimalNonNegativeInteger({
      value: columnsRaw ?? String(defaultColumns),
      label: 'column count',
    });
    if (!columnsParsedRaw.ok) {
      await context.text().error({ text: `xxd: ${columnsParsedRaw.message}\n` });
      return { exitCode: 1 };
    }
    const columnsParsed = {
      ok: true as const,
      value: columnsParsedRaw.value === 0 ? defaultColumns : columnsParsedRaw.value,
    };
    if (columnsParsed.value > MAX_COLUMNS) {
      await context.text().error({ text: `xxd: invalid column count: '${columnsRaw ?? String(defaultColumns)}'\n` });
      return { exitCode: 1 };
    }

    const groupSizeParsedRaw = parseDecimalNonNegativeInteger({
      value: groupSizeRaw ?? '2',
      label: 'group size',
    });
    if (!groupSizeParsedRaw.ok) {
      await context.text().error({ text: `xxd: ${groupSizeParsedRaw.message}\n` });
      return { exitCode: 1 };
    }
    const groupSizeParsed = {
      ok: true as const,
      value: groupSizeParsedRaw.value === 0 ? columnsParsed.value : groupSizeParsedRaw.value,
    };

    const lengthParsedRaw = lengthRaw === undefined
      ? { ok: true as const, value: undefined }
      : parseNonNegativeBigInt({ value: lengthRaw, label: 'length' });
    if (!lengthParsedRaw.ok) {
      await context.text().error({ text: `xxd: ${lengthParsedRaw.message}\n` });
      return { exitCode: 1 };
    }
    const lengthParsed = {
      ok: true as const,
      value: lengthParsedRaw.value,
    };

    const reverse = parsed.optionValues.reverse === true;
    const seekParsed = seekRaw === undefined
      ? { ok: true as const, value: 0n }
      : parseSignedBigInt({ value: seekRaw, label: 'seek offset' });
    if (!seekParsed.ok) {
      await context.text().error({ text: `xxd: ${seekParsed.message}\n` });
      return { exitCode: 1 };
    }
    const displayOffsetParsed = displayOffsetRaw === undefined
      ? { ok: true as const, value: 0n }
      : parseSignedBigInt({ value: displayOffsetRaw, label: 'display offset' });
    if (!displayOffsetParsed.ok) {
      await context.text().error({ text: `xxd: ${displayOffsetParsed.message}\n` });
      return { exitCode: 1 };
    }

    try {
      const plain = parsed.optionValues.plain === true;
      const inputPath = parsed.positionals[0];
      const resolvedInputPath = inputPath === undefined || inputPath === '-'
        ? undefined
        : resolvePath({ cwd: context.cwd, path: inputPath });
      if (reverse) {
        if (
          seekParsed.value < BigInt(Number.MIN_SAFE_INTEGER)
          || seekParsed.value > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          await context.text().error({ text: `xxd: invalid seek offset: '${seekRaw ?? '0'}'\n` });
          return { exitCode: 1 };
        }
        await reverseXxd({
          context,
          input: parsed.positionals[0],
          output: parsed.positionals[1],
          plain,
          outputOffset: Number(seekParsed.value),
        });
        return { exitCode: 0 };
      }

      const inputStat = resolvedInputPath === undefined
        ? await context.stdin.stat()
        : await context.files.stat({ path: resolvedInputPath });
      const inputName = inputPath === undefined || inputPath === '-' ? 'stdin' : inputPath;
      let resolvedForwardSeek = seekParsed.value;
      let inputIsPastEnd = false;
      const inputType = inputStat.type;
      switch (inputType) {
      case 'fifo':
      case 'chardev':
        if (resolvedForwardSeek !== 0n) {
          await context.text().error({ text: `xxd: ${inputName}: Illegal seek\n` });
          return { exitCode: 1 };
        }
        break;
      case 'file':
        if (resolvedForwardSeek < 0n) {
          resolvedForwardSeek = BigInt(inputStat.size) + resolvedForwardSeek;
          if (resolvedForwardSeek < 0n) {
            await context.text().error({ text: `xxd: ${inputName}: Sorry, cannot seek.\n` });
            return { exitCode: 1 };
          }
        }
        inputIsPastEnd = resolvedForwardSeek >= BigInt(inputStat.size);
        break;
      case 'directory':
      case 'symlink':
        if (resolvedForwardSeek < 0n) {
          await context.text().error({ text: `xxd: ${inputName}: Sorry, cannot seek.\n` });
          return { exitCode: 1 };
        }
        break;
      default: {
        const _ex: never = inputType;
        throw new Error(`Unhandled input stat type: ${String(_ex)}`);
      }
      }

      if (!inputIsPastEnd && resolvedForwardSeek > BigInt(Number.MAX_SAFE_INTEGER)) {
        await context.text().error({ text: `xxd: invalid seek offset: '${seekRaw ?? '0'}'\n` });
        return { exitCode: 1 };
      }
      const forwardSeek = inputIsPastEnd ? 0 : Number(resolvedForwardSeek);
      const initialDisplayOffset = resolvedForwardSeek + displayOffsetParsed.value;

      const outputPath = parsed.positionals[1];
      const resolvedOutputPath = outputPath === undefined || outputPath === '-'
        ? undefined
        : resolvePath({ cwd: context.cwd, path: outputPath });
      let inputAndOutputAreSameFile = false;
      if (resolvedInputPath !== undefined && resolvedOutputPath !== undefined) {
        try {
          const inputStat = await context.files.stat({ path: resolvedInputPath });
          const outputStat = await context.files.stat({ path: resolvedOutputPath });
          inputAndOutputAreSameFile = resolvedInputPath === resolvedOutputPath
            || (inputStat.ino !== 0 && inputStat.ino === outputStat.ino);
        } catch {
          // Missing output files and ordinary input-open failures are handled by
          // the normal open path below, which preserves xxd's operand diagnostics.
        }
      }
      const stream = await openCommandInputStream({
        context,
        input: inputPath,
      });
      const outputHandle = resolvedOutputPath === undefined
        ? context.stdout
        : await withXxdOperandError({
          operand: outputPath ?? '-',
          operation: async () => context.files.open({
            path: resolvedOutputPath,
            flags: {
              access: 'write',
              creation: 'if-needed',
              truncate: 'truncate',
              append: 'preserve',
            },
          }),
        });
      const closeOutput = outputHandle === context.stdout
        ? async (): Promise<void> => undefined
        : async (): Promise<void> => withXxdOperandError({
          operand: outputPath ?? '-',
          operation: async () => outputHandle.close(),
        });
      const writer = createBufferedTextWriter({
        handle: outputHandle,
        maxBufferLength: 16 * 1024,
      });
      if (inputAndOutputAreSameFile) {
        await closeOutput();
        return { exitCode: 0 };
      }
      const uppercase = parsed.optionValues.uppercase === true;
      const autoskip = parsed.optionValues.autoskip === true;
      let displayOffset = initialDisplayOffset;
      let skippingZeroLines = false;
      try {
        const rows = inputIsPastEnd
          ? []
          : iterateXxdRows({
            stream,
            columns: columnsParsed.value,
            seek: forwardSeek,
            length: lengthParsed.value,
          });
        for await (const row of rows) {
          const isZeroLine = row.byteLength === columnsParsed.value && row.every(byte => byte === 0);
          if (!plain && autoskip && isZeroLine) {
            if (!skippingZeroLines) {
              await writer.write({ text: '*\n' });
              skippingZeroLines = true;
            }
            displayOffset += BigInt(row.byteLength);
            continue;
          }

          skippingZeroLines = false;
          await writer.write({
            text: plain
              ? renderPlainLine({ bytes: row, uppercase })
              : renderNormalLine({
                bytes: row,
                columns: columnsParsed.value,
                groupSize: groupSizeParsed.value,
                uppercase,
                displayOffset,
              }),
          });
          displayOffset += BigInt(row.byteLength);
        }
        await writer.flush();
        return { exitCode: 0 };
      } finally {
        await closeOutput();
      }
    } catch (error: unknown) {
      const name = error instanceof XxdOperandError
        ? error.operand
        : parsed.positionals[0] ?? '-';
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `xxd: ${name}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
