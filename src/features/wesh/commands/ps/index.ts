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
type PsSortKey = 'user' | 'pid' | 'ppid' | 'pgid' | 'stat' | 'cwd';

interface PsSortSpecifier {
  key: PsSortKey,
  direction: 1 | -1,
}

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
      short: 'q',
      long: 'quick-pid',
      key: 'quickPidList',
      valueName: 'PIDLIST',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'select by process ID list in the given order', valueName: 'PIDLIST', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'ppid',
      key: 'ppidList',
      valueName: 'PIDLIST',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'select by parent process ID list', valueName: 'PIDLIST', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'no-headers',
      effects: [{ key: 'noHeaders', value: true }],
      help: { summary: 'print no header line at all', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'forest',
      effects: [{ key: 'forest', value: true }],
      help: { summary: 'show process hierarchy as an ASCII tree', category: 'common' },
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
      kind: 'value',
      short: undefined,
      long: 'sort',
      key: 'sort',
      valueName: 'KEYS',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'sort by existing process metadata', valueName: 'KEYS', category: 'advanced' },
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

const USER_DEFINED_PID_FAMILY_MINIMUM_WIDTH = 7;

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

    const userDefinedDefinition = definition.key === 'pid' || definition.key === 'ppid' || definition.key === 'pgid'
      ? {
        ...definition,
        minimumWidth: Math.max(definition.minimumWidth, USER_DEFINED_PID_FAMILY_MINIMUM_WIDTH),
      }
      : definition;

    columns.push(customHeader === undefined
      ? userDefinedDefinition
      : {
        ...userDefinedDefinition,
        header: customHeader,
      });
  }

  return {
    kind: 'ok',
    columns,
  };
}

function parseSortList({
  raw,
}: {
  raw: string,
}): { kind: 'ok', specifiers: PsSortSpecifier[] } | { kind: 'error', message: string } {
  const tokens = raw.split(',');
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return { kind: 'error', message: 'ps: sort list cannot be empty' };
  }

  const specifiers: PsSortSpecifier[] = [];
  for (const token of tokens) {
    const prefix = token[0];
    const direction: 1 | -1 = prefix === '-' ? -1 : 1;
    const keyText = prefix === '-' || prefix === '+' ? token.slice(1) : token;
    const normalized = keyText.toLowerCase();
    const key = (() => {
      switch (normalized) {
      case 'pid':
      case 'ppid':
      case 'pgid':
      case 'stat':
      case 'user':
      case 'cwd':
        return normalized;
      default:
        return undefined;
      }
    })();
    if (key === undefined) {
      return { kind: 'error', message: `ps: unsupported sort key: ${keyText}` };
    }
    specifiers.push({ key, direction });
  }
  return { kind: 'ok', specifiers };
}

function compareStrings({ left, right }: { left: string, right: string }): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortProcesses({
  processes,
  specifiers,
}: {
  processes: WeshProcessSnapshot[],
  specifiers: readonly PsSortSpecifier[],
}): WeshProcessSnapshot[] {
  return processes.slice().sort((left, right) => {
    for (const specifier of specifiers) {
      const comparison = (() => {
        switch (specifier.key) {
        case 'pid': return left.pid - right.pid;
        case 'ppid': return left.ppid - right.ppid;
        case 'pgid': return left.pgid - right.pgid;
        case 'stat': return compareStrings({ left: psColumns.stat.getValue({ process: left }), right: psColumns.stat.getValue({ process: right }) });
        case 'user': return compareStrings({ left: left.user, right: right.user });
        case 'cwd': return compareStrings({ left: left.cwd, right: right.cwd });
        default: {
          const _ex: never = specifier.key;
          throw new Error(`Unhandled ps sort key: ${_ex}`);
        }
        }
      })();
      if (comparison !== 0) return comparison * specifier.direction;
    }
    return 0;
  });
}

interface PsForestLayout {
  processes: WeshProcessSnapshot[],
  depthByPid: ReadonlyMap<number, number>,
}

function layoutProcessesAsForest({
  processes,
}: {
  processes: WeshProcessSnapshot[],
}): PsForestLayout {
  const processByPid = new Map<number, WeshProcessSnapshot>();
  for (const process of processes) {
    if (!processByPid.has(process.pid)) processByPid.set(process.pid, process);
  }

  const childrenByParentPid = new Map<number, WeshProcessSnapshot[]>();
  for (const process of processes) {
    if (process.ppid === process.pid || !processByPid.has(process.ppid)) continue;
    const children = childrenByParentPid.get(process.ppid) ?? [];
    children.push(process);
    childrenByParentPid.set(process.ppid, children);
  }

  const ordered: WeshProcessSnapshot[] = [];
  const depthByPid = new Map<number, number>();
  const visitedPids = new Set<number>();

  const visit = ({ process, depth }: { process: WeshProcessSnapshot, depth: number }): void => {
    if (visitedPids.has(process.pid)) return;
    visitedPids.add(process.pid);
    ordered.push(process);
    depthByPid.set(process.pid, depth);
    for (const child of childrenByParentPid.get(process.pid) ?? []) {
      visit({ process: child, depth: depth + 1 });
    }
  };

  for (const process of processes) {
    if (process.ppid === process.pid || !processByPid.has(process.ppid)) {
      visit({ process, depth: 0 });
    }
  }

  // A malformed cycle has no natural root. Keep output finite and deterministic by
  // starting each still-unvisited component at the first process in the requested order.
  for (const process of processes) {
    visit({ process, depth: 0 });
  }

  return { processes: ordered, depthByPid };
}

function forestCommandPrefix({ depth }: { depth: number }): string {
  if (depth <= 0) return '';
  return `${' '.repeat(1 + ((depth - 1) * 4))}\\_ `;
}

function decorateForestColumns({
  columns,
  depthByPid,
}: {
  columns: PsColumnDefinition[],
  depthByPid: ReadonlyMap<number, number>,
}): PsColumnDefinition[] {
  return columns.map((column) => {
    if (column.key !== 'args' && column.key !== 'comm') return column;
    return {
      ...column,
      getValue: ({ process }) => `${forestCommandPrefix({ depth: depthByPid.get(process.pid) ?? 0 })}${column.getValue({ process })}`,
    };
  });
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
  includeHeader = true,
}: {
  columns: PsColumnDefinition[],
  processes: WeshProcessSnapshot[],
  includeHeader?: boolean,
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
  if (includeHeader && header.length > 0) lines.push(header);
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
        && (occurrence.key === 'pidList' || occurrence.key === 'quickPidList' || occurrence.key === 'ppidList')
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

    const quickPidSelections = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'quickPidList'
      ))
      .map((occurrence) => {
        if (!isStringValue(occurrence.value)) {
          throw new Error('ps: internal error: expected string quick PID list');
        }
        return occurrence.value;
      });

    const ppidSelections = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'ppidList'
      ))
      .map((occurrence) => {
        if (!isStringValue(occurrence.value)) {
          throw new Error('ps: internal error: expected string parent PID list');
        }
        return occurrence.value;
      });

    const selectedPids = new Set<number>();
    const quickPids: number[] = [];
    const selectedParentPids = new Set<number>();
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

    for (const rawPidList of quickPidSelections) {
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
        quickPids.push(...parsedPidList.pids);
        break;
      default: {
        const _ex: never = parsedPidList;
        throw new Error(`Unhandled ps quick PID list parse result: ${JSON.stringify(_ex)}`);
      }
      }
    }

    for (const rawPpidList of ppidSelections) {
      const parsedPpidList = parsePidList({ raw: rawPpidList });
      switch (parsedPpidList.kind) {
      case 'error':
        await writeCommandUsageError({
          context,
          command: 'ps',
          message: parsedPpidList.message,
          argvSpec: psArgvSpec,
        });
        return { exitCode: 1 };
      case 'ok':
        for (const ppid of parsedPpidList.pids) selectedParentPids.add(ppid);
        break;
      default: {
        const _ex: never = parsedPpidList;
        throw new Error(`Unhandled ps parent PID list parse result: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const quickSelectionActive = quickPidSelections.length > 0;
    if (
      quickSelectionActive
      && (parsed.optionValues.all === true || pidSelections.length > 0 || ppidSelections.length > 0)
    ) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: 'ps: q/-q/--quick-pid cannot be combined with other selection options',
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

    const sortOccurrences = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => (
        occurrence.kind === 'value' && occurrence.key === 'sort'
      ));
    const sortSpecifiers: PsSortSpecifier[] = [];
    for (const sortOccurrence of sortOccurrences) {
      if (!isStringValue(sortOccurrence.value)) {
        throw new Error('ps: internal error: expected string sort list');
      }
      const parsedSort = parseSortList({ raw: sortOccurrence.value });
      switch (parsedSort.kind) {
      case 'error':
        await writeCommandUsageError({
          context,
          command: 'ps',
          message: parsedSort.message,
          argvSpec: psArgvSpec,
        });
        return { exitCode: 1 };
      case 'ok':
        sortSpecifiers.push(...parsedSort.specifiers);
        break;
      default: {
        const _ex: never = parsedSort;
        throw new Error(`Unhandled ps sort parse result: ${JSON.stringify(_ex)}`);
      }
      }
    }

    if (quickSelectionActive && parsed.optionValues.forest === true) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: 'ps: q/-q/--quick-pid cannot be used together with forest type listings',
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (quickSelectionActive && sortOccurrences.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'ps',
        message: 'ps: q/-q,--quick-pid cannot be used together with sort options',
        argvSpec: psArgvSpec,
      });
      return { exitCode: 1 };
    }

    const selectedProcesses = (() => {
      if (quickSelectionActive) {
        const processByPid = new Map(
          processes
            .filter(process => process.state !== 'terminated')
            .map(process => [process.pid, process] as const),
        );
        return quickPids.flatMap((pid) => {
          const process = processByPid.get(pid);
          return process === undefined ? [] : [process];
        });
      }
      if (parsed.optionValues.all === true) {
        return processes.filter(process => process.state !== 'terminated');
      }
      if (selectedPids.size > 0 || selectedParentPids.size > 0) {
        return processes.filter(process => (
          process.state !== 'terminated' &&
          (selectedPids.has(process.pid) || selectedParentPids.has(process.ppid))
        ));
      }
      return defaultProcessSelection({
        context,
        processes,
      });
    })();

    const selectedOrder = quickSelectionActive || sortSpecifiers.length === 0
      ? selectedProcesses
      : sortProcesses({ processes: selectedProcesses, specifiers: sortSpecifiers });
    const forestLayout = parsed.optionValues.forest === true
      ? layoutProcessesAsForest({ processes: selectedOrder })
      : undefined;
    const orderedProcesses = forestLayout?.processes ?? selectedOrder;
    const outputColumns = forestLayout === undefined
      ? columns.columns
      : decorateForestColumns({ columns: columns.columns, depthByPid: forestLayout.depthByPid });

    await context.text().print({
      text: formatProcesses({
        columns: outputColumns,
        processes: orderedProcesses,
        includeHeader: parsed.optionValues.noHeaders !== true,
      }),
    });
    return {
      exitCode: (
        quickSelectionActive || selectedPids.size > 0 || selectedParentPids.size > 0
      ) && selectedProcesses.length === 0 ? 1 : 0,
    };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  decorateForestColumns,
  defaultColumns,
  formatProcesses,
  layoutProcessesAsForest,
  parseFormatList,
  parseSortList,
  sortProcesses,
};
