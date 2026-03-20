import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const dateArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'utc', value: true }], help: { summary: 'display the time in UTC' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: false,
  specialTokenParsers: [],
};

function pad2({
  value,
}: {
  value: number;
}): string {
  return value.toString().padStart(2, '0');
}

function formatDateToken({
  token,
  date,
  utc,
}: {
  token: string;
  date: Date;
  utc: boolean;
}): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = utc ? date.getUTCMonth() + 1 : date.getMonth() + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  const hours = utc ? date.getUTCHours() : date.getHours();
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
  const seconds = utc ? date.getUTCSeconds() : date.getSeconds();

  switch (token) {
  case '%Y':
    return year.toString().padStart(4, '0');
  case '%m':
    return pad2({ value: month });
  case '%d':
    return pad2({ value: day });
  case '%H':
    return pad2({ value: hours });
  case '%M':
    return pad2({ value: minutes });
  case '%S':
    return pad2({ value: seconds });
  case '%F':
    return `${formatDateToken({ token: '%Y', date, utc })}-${formatDateToken({ token: '%m', date, utc })}-${formatDateToken({ token: '%d', date, utc })}`;
  case '%T':
    return `${formatDateToken({ token: '%H', date, utc })}:${formatDateToken({ token: '%M', date, utc })}:${formatDateToken({ token: '%S', date, utc })}`;
  case '%s':
    return Math.floor(date.getTime() / 1000).toString();
  case '%%':
    return '%';
  default:
    return token;
  }
}

function formatDate({
  format,
  date,
  utc,
}: {
  format: string;
  date: Date;
  utc: boolean;
}): string {
  return format.replace(/%[%YmdHMSTFs]/g, (token) => formatDateToken({
    token,
    date,
    utc,
  }));
}

export const dateCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u] [+FORMAT]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: dateArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: ${diagnostic.message}`,
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'date',
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: extra operand '${parsed.positionals[1] ?? ''}'`,
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 1 };
    }

    const now = new Date();
    const text = context.text();
    const utc = parsed.optionValues.utc === true;
    const format = parsed.positionals[0];
    const out = format?.startsWith('+')
      ? formatDate({
        format: format.slice(1),
        date: now,
        utc,
      })
      : utc
        ? now.toUTCString()
        : now.toString();
    await text.print({ text: out + '\n' });

    return { exitCode: 0 };
  },
};
