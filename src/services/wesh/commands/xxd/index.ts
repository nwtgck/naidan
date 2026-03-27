import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readCommandInputAsBytes } from '@/services/wesh/commands/_shared/binary-input';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

function parseNonNegativeInteger({
  value,
  label,
}: {
  value: string;
  label: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  const normalized = value.trim();
  if (!/^(?:0x[0-9a-fA-F]+|0[0-7]+|\d+)$/u.test(normalized)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = normalized.startsWith('0x') || normalized.startsWith('0X')
    ? Number.parseInt(normalized.slice(2), 16)
    : /^0[0-7]+$/u.test(normalized) && normalized !== '0'
      ? Number.parseInt(normalized, 8)
      : Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function toHex({
  value,
  uppercase,
  width,
}: {
  value: number;
  uppercase: boolean;
  width: number | undefined;
}): string {
  const raw = value.toString(16);
  const formatted = width === undefined ? raw : raw.padStart(width, '0');
  return uppercase ? formatted.toUpperCase() : formatted;
}

function renderAscii({
  bytes,
}: {
  bytes: Uint8Array;
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
  columns: number;
  groupSize: number;
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
  bytes: Uint8Array;
  columns: number;
  groupSize: number;
  uppercase: boolean;
}): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += groupSize) {
    const group = bytes.slice(index, index + groupSize);
    parts.push(Array.from(group, (byte) => toHex({ value: byte, uppercase, width: 2 })).join(''));
  }
  return parts.join(' ').padEnd(getHexColumnWidth({ columns, groupSize }), ' ');
}

function renderNormalDump({
  bytes,
  columns,
  groupSize,
  uppercase,
  autoskip,
  displayOffset,
}: {
  bytes: Uint8Array;
  columns: number;
  groupSize: number;
  uppercase: boolean;
  autoskip: boolean;
  displayOffset: number;
}): string {
  const lines: string[] = [];
  let skipped = false;

  for (let offset = 0; offset < bytes.length; offset += columns) {
    const chunk = bytes.slice(offset, offset + columns);
    const isZeroLine = chunk.length === columns && chunk.every((byte) => byte === 0);
    if (autoskip && isZeroLine) {
      if (!skipped) {
        lines.push('*\n');
        skipped = true;
      }
      continue;
    }

    skipped = false;
    lines.push(`${toHex({ value: displayOffset + offset, uppercase, width: 8 })}: ${renderHexSection({
      bytes: chunk,
      columns,
      groupSize,
      uppercase,
    })}  ${renderAscii({ bytes: chunk })}\n`);
  }

  return lines.join('');
}

function renderPlainDump({
  bytes,
  columns,
  uppercase,
}: {
  bytes: Uint8Array;
  columns: number;
  uppercase: boolean;
}): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += columns) {
    const chunk = bytes.slice(offset, offset + columns);
    result += `${Array.from(chunk, (byte) => toHex({ value: byte, uppercase, width: 2 })).join('')}\n`;
  }
  return result;
}

const xxdArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: undefined, effects: [{ key: 'autoskip', value: true }], help: { summary: 'replace repeated nul lines with *', category: 'common' } },
    { kind: 'value', short: 'c', long: undefined, key: 'columns', valueName: 'cols', allowAttachedValue: true, parseValue: undefined, help: { summary: 'set the number of octets per line', valueName: 'COLS', category: 'common' } },
    { kind: 'value', short: 'g', long: undefined, key: 'groupSize', valueName: 'bytes', allowAttachedValue: true, parseValue: undefined, help: { summary: 'group output by BYTES octets', valueName: 'BYTES', category: 'common' } },
    { kind: 'flag', short: 'h', long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'l', long: undefined, key: 'length', valueName: 'len', allowAttachedValue: true, parseValue: undefined, help: { summary: 'stop after LEN octets', valueName: 'LEN', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'p', long: 'ps', effects: [{ key: 'plain', value: true }], help: { summary: 'output in plain hexdump style', category: 'common' } },
    { kind: 'value', short: 's', long: undefined, key: 'seek', valueName: 'seek', allowAttachedValue: true, parseValue: undefined, help: { summary: 'start at SEEK bytes', valueName: 'SEEK', category: 'common' } },
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'uppercase', value: true }], help: { summary: 'use upper-case hex letters', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const xxdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'xxd',
    description: 'Make a hex dump',
    usage: 'xxd [OPTION]... [FILE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: xxdArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'xxd',
        message: `xxd: ${diagnostic.message}`,
        argvSpec: xxdArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'xxd',
        argvSpec: xxdArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'xxd',
        message: 'xxd: extra operand',
        argvSpec: xxdArgvSpec,
      });
      return { exitCode: 1 };
    }

    const columnsRaw = parsed.optionValues.columns as string | undefined;
    const groupSizeRaw = parsed.optionValues.groupSize as string | undefined;
    const lengthRaw = parsed.optionValues.length as string | undefined;
    const seekRaw = parsed.optionValues.seek as string | undefined;

    const columnsParsed = parseNonNegativeInteger({
      value: columnsRaw ?? (parsed.optionValues.plain === true ? '30' : '16'),
      label: 'column count',
    });
    if (!columnsParsed.ok || columnsParsed.value === 0) {
      await context.text().error({ text: `xxd: ${(columnsParsed.ok ? 'invalid column count' : columnsParsed.message)}\n` });
      return { exitCode: 1 };
    }

    const groupSizeParsed = parseNonNegativeInteger({
      value: groupSizeRaw ?? '2',
      label: 'group size',
    });
    if (!groupSizeParsed.ok || groupSizeParsed.value === 0) {
      await context.text().error({ text: `xxd: ${(groupSizeParsed.ok ? 'invalid group size' : groupSizeParsed.message)}\n` });
      return { exitCode: 1 };
    }

    const lengthParsed = lengthRaw === undefined
      ? { ok: true as const, value: undefined }
      : parseNonNegativeInteger({ value: lengthRaw, label: 'length' });
    if (!lengthParsed.ok) {
      await context.text().error({ text: `xxd: ${lengthParsed.message}\n` });
      return { exitCode: 1 };
    }

    const seekParsed = seekRaw === undefined
      ? { ok: true as const, value: 0 }
      : parseNonNegativeInteger({ value: seekRaw, label: 'seek offset' });
    if (!seekParsed.ok) {
      await context.text().error({ text: `xxd: ${seekParsed.message}\n` });
      return { exitCode: 1 };
    }

    try {
      const input = await readCommandInputAsBytes({
        context,
        input: parsed.positionals[0],
      });
      const sliced = input.slice(seekParsed.value, lengthParsed.value === undefined ? undefined : seekParsed.value + lengthParsed.value);
      const output = parsed.optionValues.plain === true
        ? renderPlainDump({
          bytes: sliced,
          columns: columnsParsed.value,
          uppercase: parsed.optionValues.uppercase === true,
        })
        : renderNormalDump({
          bytes: sliced,
          columns: columnsParsed.value,
          groupSize: groupSizeParsed.value,
          uppercase: parsed.optionValues.uppercase === true,
          autoskip: parsed.optionValues.autoskip === true,
          displayOffset: seekParsed.value,
        });

      await context.text().print({ text: output });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const name = parsed.positionals[0] ?? '-';
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `xxd: ${name}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
