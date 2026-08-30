import { parseStandardArgv, type ArgvOptionOccurrence, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { getWeshTextDisplayWidth } from '@/features/wesh/utils/display-width';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshProcessSnapshot,
} from '@/features/wesh/types';

type PsColumnKey = 'user' | 'pid' | 'ppid' | 'pgid' | 'stat' | 'args' | 'comm' | 'cwd';

interface PsColumnDefinition {
  key: PsColumnKey,
  header: string,
  alignment: 'left' | 'right',
  minimumWidth: number,
  getValue({ process }: { process: WeshProcessSnapshot }): string,
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
      short: 'f',
      long: 'full',
      effects: [{ key: 'full', value: true }],
      help: { summary: 'use a fuller default output format', category: 'common' },
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
  user: {
    key: 'user',
    header: 'USER',
    alignment: 'left',
    minimumWidth: 4,
    getValue: ({ process }) => process.user,
  },
  pid: {
    key: 'pid',
    header: 'PID',
    alignment: 'right',
    minimumWidth: 5,
    getValue: ({ process }) => process.pid.toString(),
  },
  ppid: {
    key: 'ppid',
    header: 'PPID',
    alignment: 'right',
    minimumWidth: 5,
    getValue: ({ process }) => process.ppid.toString(),
  },
  pgid: {
    key: 'pgid',
    header: 'PGID',
    alignment: 'right',
    minimumWidth: 5,
    getValue: ({ process }) => process.pgid.toString(),
  },
  stat: {
    key: 'stat',
    header: 'STAT',
    alignment: 'left',
    minimumWidth: 4,
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
    header: 'COMMAND',
    alignment: 'left',
    minimumWidth: 7,
    getValue: ({ process }) => (process.args.length === 0
      ? process.argv0.trim()
      : `${process.argv0} ${process.args.join(' ')}`.trim()),
  },
  comm: {
    key: 'comm',
    header: 'COMMAND',
    alignment: 'left',
    minimumWidth: 7,
    getValue: ({ process }) => process.argv0.split('/').at(-1) ?? process.argv0,
  },
  cwd: {
    key: 'cwd',
    header: 'CWD',
    alignment: 'left',
    minimumWidth: 3,
    getValue: ({ process }) => process.cwd,
  },
};

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}

function parsePidList({
  raw,
}: {
  raw: string,
}): { kind: 'ok', pids: number[] } | { kind: 'error', message: string } {
  const tokens = raw.split(',');
  if (tokens.length === 0 || tokens.some(token => token.length === 0)) {
    return {
      kind: 'error',
      message: 'ps: process ID list cannot be empty',
    };
  }

  const pids: number[] = [];
  for (const token of tokens) {
    if (!/^\+?\d+$/u.test(token)) {
      return {
        kind: 'error',
        message: `ps: invalid process ID: ${token}`,
      };
    }
    const pid = Number(token);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return {
        kind: 'error',
        message: `ps: process ID out of range: ${token}`,
      };
    }
    pids.push(pid);
  }

  return {
    kind: 'ok',
    pids,
  };
}

function parseFormatList({
  raw,
}: {
  raw: string,
}): { kind: 'ok', columns: PsColumnDefinition[] } | { kind: 'error', message: string } {
  const tokens = raw.split(/[, \t\n\v\f\r]+/u).filter(part => part.length > 0);
  if (tokens.length === 0) {
    return {
      kind: 'error',
      message: 'ps: format list cannot be empty',
    };
  }

  const columns: PsColumnDefinition[] = [];
  for (const token of tokens) {
    const equalsIndex = token.indexOf('=');
    const specifier = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const customHeader = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    const normalized = specifier.toLowerCase();

    const definition = (() => {
      switch (normalized) {
      case 'command':
      case 'cmd':
        return psColumns.args;
      case 'comm':
        return psColumns.comm;
      case 'pid':
      case 'ppid':
      case 'pgid':
      case 'stat':
      case 'args':
      case 'cwd':
      case 'user':
        return psColumns[normalized];
      default:
        return undefined;
      }
    })();

    if (definition === undefined) {
      return {
        kind: 'error',
        message: `ps: unknown user-defined format specifier: ${specifier}`,
      };
    }

    columns.push(customHeader === undefined
      ? definition
      : {
        ...definition,
        header: customHeader,
      });
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

function fullColumns(): PsColumnDefinition[] {
  return [
    psColumns.user,
    psColumns.pid,
    psColumns.ppid,
    psColumns.pgid,
    psColumns.stat,
    psColumns.args,
  ];
}

function defaultProcessSelection({
  context,
  processes,
}: {
  context: WeshCommandContext,
  processes: WeshProcessSnapshot[],
}): WeshProcessSnapshot[] {
  return processes.filter((process) => (
    process.state !== 'terminated' &&
    process.pgid === context.process.getGroupId()
  ));
}

function sanitizePsValue({
  value,
}: {
  value: string,
}): string {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === '\n') {
      sanitized += ' ';
    } else if (
      codePoint !== undefined
      && (codePoint < 0x20 || (codePoint >= 0x7F && codePoint < 0xA0))
    ) {
      sanitized += '?';
    } else {
      sanitized += character;
    }
  }
  return sanitized;
}

function formatProcesses({
  columns,
  processes,
}: {
  columns: PsColumnDefinition[],
  processes: WeshProcessSnapshot[],
}): string {
  const headers = columns.map((column) => sanitizePsValue({ value: column.header }));
  const widths = columns.map((column, index) => Math.max(
    column.minimumWidth,
    getWeshTextDisplayWidth({ text: headers[index] ?? '', initialColumn: 0, tabSize: undefined }),
  ));
  for (const process of processes) {
    for (let index = 0; index < columns.length; index += 1) {
      const value = sanitizePsValue({ value: columns[index]!.getValue({ process }) });
      widths[index] = Math.max(widths[index] ?? 0, getWeshTextDisplayWidth({ text: value, initialColumn: 0, tabSize: undefined }));
    }
  }

  const formatCell = ({
    value,
    column,
    width,
  }: {
    value: string,
    column: PsColumnDefinition,
    width: number,
  }): string => {
    const padding = ' '.repeat(Math.max(0, width - getWeshTextDisplayWidth({ text: value, initialColumn: 0, tabSize: undefined })));
    switch (column.alignment) {
    case 'right':
      return `${padding}${value}`;
    case 'left':
      return `${value}${padding}`;
    default: {
      const _ex: never = column.alignment;
      throw new Error(`Unhandled ps column alignment: ${_ex}`);
    }
    }
  };

  const header = columns.map((column, index) => formatCell({
    value: headers[index]!,
    column,
    width: widths[index]!,
  })).join(' ').replace(/[ \t]+$/u, '');
  const lines: string[] = [];
  if (header.length > 0) lines.push(header);
  for (const process of processes) {
    let line = '';
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const column = columns[columnIndex]!;
      if (columnIndex > 0) line += ' ';
      line += formatCell({
        value: sanitizePsValue({ value: column.getValue({ process }) }),
        column,
        width: widths[columnIndex]!,
      });
    }
    lines.push(line.replace(/[ \t]+$/u, ''));
  }

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export const psCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: psArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: psArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: psArgvSpec,
      parsed,
      findSemanticIssue: ({ parsed: candidate }) => candidate.occurrences.find((occurrence) => (
        occurrence.kind === 'value'
        && occurrence.key === 'pidList'
        && typeof occurrence.value === 'string'
        && parsePidList({ raw: occurrence.value }).kind === 'error'
      )),
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: `ps: ${diagnostic.message}`,
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    }

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

    const formatOccurrences = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'format'
      ));

    const columns = (() => {
      if (formatOccurrences.length === 0) {
        return {
          kind: 'ok' as const,
          columns: parsed.optionValues.full === true
            ? fullColumns()
            : defaultColumns(),
        };
      }

      const combinedColumns: PsColumnDefinition[] = [];
      for (const formatOccurrence of formatOccurrences) {
        if (!isStringValue(formatOccurrence.value)) {
          throw new Error('ps: internal error: expected string format list');
        }
        const parsedFormat = parseFormatList({ raw: formatOccurrence.value });
        switch (parsedFormat.kind) {
        case 'error':
          return parsedFormat;
        case 'ok':
          for (const column of parsedFormat.columns) combinedColumns.push(column);
          break;
        default: {
          const _ex: never = parsedFormat;
          throw new Error(`Unhandled ps format parse result: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return {
        kind: 'ok' as const,
        columns: combinedColumns,
      };
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
      if (parsed.optionValues.all === true) {
        return processes.filter(process => process.state !== 'terminated');
      }
      if (selectedPids.size > 0) {
        return processes.filter(process => (
          process.state !== 'terminated' &&
          selectedPids.has(process.pid)
        ));
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
    return {
      exitCode: selectedPids.size > 0 && selectedProcesses.length === 0 ? 1 : 0,
    };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  defaultColumns,
  formatProcesses,
  parseFormatList,
};
