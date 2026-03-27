import { parseStandardArgv, type ArgvOptionOccurrence, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshProcessSnapshot,
} from '@/services/wesh/types';

type PsColumnKey = 'pid' | 'ppid' | 'pgid' | 'stat' | 'args' | 'cwd';

interface PsColumnDefinition {
  key: PsColumnKey;
  header: string;
  getValue(options: { process: WeshProcessSnapshot }): string;
}

const psArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'e',
      long: 'all',
      effects: [{ key: 'all', value: true }],
      help: { summary: 'select all visible processes', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'A',
      long: undefined,
      effects: [{ key: 'all', value: true }],
      help: { summary: 'same as -e', category: 'common' },
    },
    {
      kind: 'value',
      short: 'p',
      long: 'pid',
      key: 'pidList',
      valueName: 'PIDLIST',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'select by process ID list', valueName: 'PIDLIST', category: 'common' },
    },
    {
      kind: 'value',
      short: 'o',
      long: 'format',
      key: 'format',
      valueName: 'FORMAT',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'select output columns', valueName: 'FORMAT', category: 'common' },
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

const psColumns: Record<PsColumnKey, PsColumnDefinition> = {
  pid: {
    key: 'pid',
    header: 'PID',
    getValue: ({ process }) => process.pid.toString(),
  },
  ppid: {
    key: 'ppid',
    header: 'PPID',
    getValue: ({ process }) => process.ppid.toString(),
  },
  pgid: {
    key: 'pgid',
    header: 'PGID',
    getValue: ({ process }) => process.pgid.toString(),
  },
  stat: {
    key: 'stat',
    header: 'STAT',
    getValue: ({ process }) => {
      switch (process.state) {
      case 'running':
        return 'R';
      case 'stopped':
        return 'T';
      case 'zombie':
        return 'Z';
      case 'terminated':
        return 'X';
      default: {
        const _ex: never = process.state;
        throw new Error(`Unhandled ps process state: ${_ex}`);
      }
      }
    },
  },
  args: {
    key: 'args',
    header: 'ARGS',
    getValue: ({ process }) => [process.argv0, ...process.args].join(' ').trim(),
  },
  cwd: {
    key: 'cwd',
    header: 'CWD',
    getValue: ({ process }) => process.cwd,
  },
};

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}

function parsePidList({
  raw,
}: {
  raw: string;
}): { kind: 'ok'; pids: number[] } | { kind: 'error'; message: string } {
  const tokens = raw.split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (tokens.length === 0) {
    return {
      kind: 'error',
      message: 'ps: process ID list cannot be empty',
    };
  }

  const pids: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/u.test(token)) {
      return {
        kind: 'error',
        message: `ps: invalid process ID: ${token}`,
      };
    }
    pids.push(Number.parseInt(token, 10));
  }

  return {
    kind: 'ok',
    pids,
  };
}

function parseFormatList({
  raw,
}: {
  raw: string;
}): { kind: 'ok'; columns: PsColumnDefinition[] } | { kind: 'error'; message: string } {
  const tokens = raw.split(/[,\s]+/u).map(part => part.trim()).filter(part => part.length > 0);
  if (tokens.length === 0) {
    return {
      kind: 'error',
      message: 'ps: format list cannot be empty',
    };
  }

  const columns: PsColumnDefinition[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    switch (normalized) {
    case 'pid':
    case 'ppid':
    case 'pgid':
    case 'stat':
    case 'args':
    case 'command':
    case 'cmd':
    case 'cwd':
      break;
    default:
      return {
        kind: 'error',
        message: `ps: unknown user-defined format specifier: ${token}`,
      };
    }

    switch (normalized) {
    case 'command':
    case 'cmd':
      columns.push(psColumns.args);
      break;
    case 'pid':
    case 'ppid':
    case 'pgid':
    case 'stat':
    case 'args':
    case 'cwd':
      columns.push(psColumns[normalized]);
      break;
    default: {
      const _ex: never = normalized;
      throw new Error(`Unhandled ps format token: ${_ex}`);
    }
    }
  }

  return {
    kind: 'ok',
    columns,
  };
}

function defaultColumns(): PsColumnDefinition[] {
  return [
    psColumns.pid,
    psColumns.pgid,
    psColumns.ppid,
    psColumns.stat,
    psColumns.args,
  ];
}

function defaultProcessSelection({
  context,
  processes,
}: {
  context: WeshCommandContext;
  processes: WeshProcessSnapshot[];
}): WeshProcessSnapshot[] {
  return processes.filter((process) => (
    process.state !== 'terminated' &&
    process.pgid === context.process.getGroupId()
  ));
}

function formatProcesses({
  columns,
  processes,
}: {
  columns: PsColumnDefinition[];
  processes: WeshProcessSnapshot[];
}): string {
  const rows = processes.map((process) => columns.map((column) => column.getValue({ process })));
  const widths = columns.map((column, index) => (
    Math.max(column.header.length, ...rows.map(row => row[index]?.length ?? 0))
  ));

  const header = columns.map((column, index) => column.header.padEnd(widths[index]!)).join(' ').trimEnd();
  const body = rows.map((row) => (
    row.map((value, index) => value.padEnd(widths[index]!)).join(' ').trimEnd()
  ));

  return [header, ...body].join('\n') + '\n';
}

export const psCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'ps',
    description: 'Report process status',
    usage: 'ps [-eA] [-p PIDLIST] [-o FORMAT]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: psArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: `ps: ${diagnostic.message}`,
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'ps',
        argvSpec: psArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: 'ps: extra operand',
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    }

    const processes = context.getProcesses().slice().sort((left, right) => left.pid - right.pid);

    const pidSelections = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'pidList'
      ))
      .map((occurrence) => {
        if (!isStringValue(occurrence.value)) {
          throw new Error('ps: internal error: expected string pid list');
        }
        return occurrence.value;
      });

    const selectedPids = new Set<number>();
    for (const rawPidList of pidSelections) {
      const parsedPidList = parsePidList({ raw: rawPidList });
      switch (parsedPidList.kind) {
      case 'error':
        await writeCommandUsageError({
          context,
          command: 'ps',
          message: parsedPidList.message,
          argvSpec: psArgvSpec,
        });
        return { exitCode: 1 };
      case 'ok':
        for (const pid of parsedPidList.pids) {
          selectedPids.add(pid);
        }
        break;
      default: {
        const _ex: never = parsedPidList;
        throw new Error(`Unhandled ps pid list parse result: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const formatOccurrence = parsed.occurrences
      .find((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'format'
      ));

    const columns = (() => {
      if (formatOccurrence === undefined) {
        return {
          kind: 'ok' as const,
          columns: defaultColumns(),
        };
      }
      return parseFormatList({
        raw: (() => {
          if (!isStringValue(formatOccurrence.value)) {
            throw new Error('ps: internal error: expected string format list');
          }
          return formatOccurrence.value;
        })(),
      });
    })();

    switch (columns.kind) {
    case 'error':
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: columns.message,
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    case 'ok':
      break;
    default: {
      const _ex: never = columns;
      throw new Error(`Unhandled ps columns parse result: ${JSON.stringify(_ex)}`);
    }
    }

    const selectedProcesses = (() => {
      if (selectedPids.size > 0) {
        return processes.filter(process => (
          process.state !== 'terminated' &&
          selectedPids.has(process.pid)
        ));
      }
      if (parsed.optionValues.all === true) {
        return processes.filter(process => process.state !== 'terminated');
      }
      return defaultProcessSelection({
        context,
        processes,
      });
    })();

    await context.text().print({
      text: formatProcesses({
        columns: columns.columns,
        processes: selectedProcesses,
      }),
    });
    return { exitCode: 0 };
  },
};
