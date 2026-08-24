import { standardSemanticIssuePrecedesDiagnostic } from '@/features/wesh/commands/_shared/argv';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type {
  ArgvOptionOccurrence,
  StandardArgvParserSpec,
} from '@/features/wesh/argv';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { DuOutputFormat } from './format';
import {
  parseDuBlockSize,
  parseDuThreshold,
  type DuThreshold,
} from './format';

export type DuSymlinkMode = 'physical' | 'command-line' | 'logical';
export type DuMetric = 'logical-bytes' | 'inodes';

export interface DuOptions {
  showAll: boolean,
  summarize: boolean,
  maxDepth: number | undefined,
  showTotal: boolean,
  separateDirs: boolean,
  recordTerminator: '\n' | '\0',
  symlinkMode: DuSymlinkMode,
  countLinks: boolean,
  metric: DuMetric,
  outputFormat: DuOutputFormat,
  threshold: DuThreshold | undefined,
  files0From: string | undefined,
  excludePatterns: string[],
  excludeFromFiles: string[],
  logicalSizeOptionRequested: boolean,
}

export type DuOptionsParseResult =
  | {
      ok: true,
      options: DuOptions,
      operands: string[],
      helpRequested: boolean,
      preHelpDiagnostics: readonly string[],
    }
  | {
      ok: false,
      message: string,
    };

function parseNonNegativeInteger({ value }: { value: string }):
  | { ok: true, value: number }
  | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?[0-9]+$/u.test(numericText)) {
    return {
      ok: false,
      message: `invalid maximum depth '${value}'`,
    };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      message: `maximum depth is too large: '${value}'`,
    };
  }

  return { ok: true, value: parsed };
}

export const duArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: '0', long: 'null', effects: [{ key: 'recordTerminator', value: 'null' }], help: { summary: 'end each output line with NUL, not newline', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'all', effects: [{ key: 'showAll', value: true }], help: { summary: 'write counts for all files, not just directories', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'apparent-size', effects: [{ key: 'apparentSize', value: true }], help: { summary: 'use logical file sizes (the Wesh default)', category: 'advanced' } },
    { kind: 'flag', short: 'b', long: 'bytes', effects: [{ key: 'outputMode', value: 'bytes' }], help: { summary: 'equivalent to --apparent-size --block-size=1', category: 'common' } },
    { kind: 'value', short: 'B', long: 'block-size', key: 'blockSize', valueName: 'SIZE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'scale sizes by SIZE before printing', valueName: 'SIZE', category: 'common' } },
    { kind: 'flag', short: 'c', long: 'total', effects: [{ key: 'showTotal', value: true }], help: { summary: 'produce a grand total', category: 'common' } },
    { kind: 'flag', short: 'D', long: 'dereference-args', effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'dereference only command-line symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'equivalent to --dereference-args', category: 'advanced' } },
    { kind: 'value', short: 'd', long: 'max-depth', key: 'maxDepth', valueName: 'N', allowAttachedValue: true, parseValue: parseNonNegativeInteger, help: { summary: 'print entries only if they are N or fewer levels below an argument', valueName: 'N', category: 'common' } },
    { kind: 'value', short: undefined, long: 'files0-from', key: 'files0From', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'read NUL-terminated file names from FILE', valueName: 'FILE', category: 'advanced' } },
    { kind: 'flag', short: 'h', long: 'human-readable', effects: [{ key: 'outputMode', value: 'human-1024' }], help: { summary: 'print sizes in powers of 1024', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'si', effects: [{ key: 'outputMode', value: 'human-1000' }], help: { summary: 'print sizes in powers of 1000', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'inodes', effects: [{ key: 'metric', value: 'inodes' }], help: { summary: 'list entry counts instead of byte usage', category: 'advanced' } },
    { kind: 'flag', short: 'k', long: undefined, effects: [{ key: 'outputMode', value: 'kibibytes' }], help: { summary: 'like --block-size=1K', category: 'common' } },
    { kind: 'flag', short: 'L', long: 'dereference', effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'dereference all symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'l', long: 'count-links', effects: [{ key: 'countLinks', value: true }], help: { summary: 'count repeated resolved entries multiple times', category: 'advanced' } },
    { kind: 'flag', short: 'm', long: undefined, effects: [{ key: 'outputMode', value: 'mebibytes' }], help: { summary: 'like --block-size=1M', category: 'common' } },
    { kind: 'flag', short: 'P', long: 'no-dereference', effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'do not follow symbolic links (the default)', category: 'advanced' } },
    { kind: 'flag', short: 'S', long: 'separate-dirs', effects: [{ key: 'separateDirs', value: true }], help: { summary: 'for directories, exclude subdirectory sizes from displayed values', category: 'advanced' } },
    { kind: 'flag', short: 's', long: 'summarize', effects: [{ key: 'summarize', value: true }], help: { summary: 'display only a total for each argument', category: 'common' } },
    { kind: 'value', short: 't', long: 'threshold', key: 'threshold', valueName: 'SIZE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'exclude entries outside the SIZE threshold', valueName: 'SIZE', category: 'advanced' } },
    { kind: 'value', short: 'X', long: 'exclude-from', key: 'excludeFrom', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'exclude entries matching patterns from FILE', valueName: 'FILE', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'exclude', key: 'excludePattern', valueName: 'PATTERN', allowAttachedValue: false, parseValue: undefined, help: { summary: 'exclude entries matching PATTERN', valueName: 'PATTERN', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function getDefaultOutputFormat({ env }: { env: Map<string, string> }): DuOutputFormat {
  for (const key of ['DU_BLOCK_SIZE', 'BLOCK_SIZE', 'BLOCKSIZE']) {
    const raw = env.get(key);
    if (raw === undefined) {
      continue;
    }
    const parsed = parseDuBlockSize({ value: raw });
    if (parsed.ok) {
      return parsed.outputFormat;
    }
    break;
  }

  return {
    kind: 'blocks',
    unit: env.has('POSIXLY_CORRECT') ? 512n : 1024n,
    suffix: '',
  };
}

function applyOccurrence({
  occurrence,
  state,
}: {
  occurrence: ArgvOptionOccurrence,
  state: {
    outputFormat: DuOutputFormat,
    symlinkMode: DuSymlinkMode,
    metric: DuMetric,
    excludePatterns: string[],
    excludeFromFiles: string[],
    logicalSizeOptionRequested: boolean,
    threshold: DuThreshold | undefined,
  },
}): { ok: true } | { ok: false, message: string } {
  switch (occurrence.kind) {
  case 'flag':
  case 'special': {
    for (const effect of occurrence.effects) {
      switch (effect.key) {
      case 'outputMode':
        switch (effect.value) {
        case 'bytes':
          state.outputFormat = { kind: 'blocks', unit: 1n, suffix: '' };
          state.logicalSizeOptionRequested = true;
          break;
        case 'human-1024':
          state.outputFormat = { kind: 'human', base: 1024 };
          break;
        case 'human-1000':
          state.outputFormat = { kind: 'human', base: 1000 };
          break;
        case 'kibibytes':
          state.outputFormat = { kind: 'blocks', unit: 1024n, suffix: '' };
          break;
        case 'mebibytes':
          state.outputFormat = { kind: 'blocks', unit: 1024n * 1024n, suffix: '' };
          break;
        default:
          break;
        }
        break;
      case 'apparentSize':
        if (effect.value === true) {
          state.logicalSizeOptionRequested = true;
        }
        break;
      case 'symlinkMode':
        if (effect.value === 'physical' || effect.value === 'command-line' || effect.value === 'logical') {
          state.symlinkMode = effect.value;
        }
        break;
      case 'metric':
        if (effect.value === 'inodes') {
          state.metric = effect.value;
        }
        break;
      default:
        break;
      }
    }
    return { ok: true };
  }
  case 'value':
    switch (occurrence.key) {
    case 'blockSize': {
      if (typeof occurrence.value !== 'string') {
        return { ok: false, message: 'du: invalid block size' };
      }
      const parsed = parseDuBlockSize({ value: occurrence.value });
      if (!parsed.ok) {
        return { ok: false, message: `du: ${parsed.message}` };
      }
      state.outputFormat = parsed.outputFormat;
      return { ok: true };
    }
    case 'excludePattern':
      if (typeof occurrence.value === 'string') {
        state.excludePatterns.push(occurrence.value);
      }
      return { ok: true };
    case 'excludeFrom':
      if (typeof occurrence.value === 'string') {
        state.excludeFromFiles.push(occurrence.value);
      }
      return { ok: true };
    case 'threshold': {
      if (typeof occurrence.value !== 'string') {
        return { ok: false, message: 'du: invalid threshold' };
      }
      const parsed = parseDuThreshold({ value: occurrence.value });
      if (!parsed.ok) {
        return {
          ok: false,
          message: `du: invalid ${occurrence.option} argument '${occurrence.value}'`,
        };
      }
      state.threshold = parsed.threshold;
      return { ok: true };
    }
    case 'maxDepth':
    case 'files0From':
      return { ok: true };
    default:
      return { ok: true };
    }
  default: {
    const _ex: never = occurrence;
    throw new Error(`Unhandled du option occurrence: ${_ex}`);
  }
  }
}

function truncateArgsAtHelp({ args }: { args: string[] }): string[] {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--help') continue;
    const prefix = args.slice(0, index + 1);
    const parsedPrefix = parseStandardArgv({ args: prefix, spec: duArgvSpec });
    if (parsedPrefix.optionValues.help === true) return prefix;
  }
  return args;
}

export function parseDuOptions({
  args,
  env,
}: {
  args: string[],
  env: Map<string, string>,
}): DuOptionsParseResult {
  const parsedArgs = truncateArgsAtHelp({ args });
  const parsed = parseStandardArgv({ args: parsedArgs, spec: duArgvSpec });
  const helpRequested = parsed.optionValues.help === true;
  const diagnostic = parsed.diagnostics[0];
  const semanticIssuePrecedesDiagnostic = !helpRequested && standardSemanticIssuePrecedesDiagnostic({
    args: parsedArgs,
    spec: duArgvSpec,
    parsed,
    findSemanticIssue: ({ parsed: candidate }) => {
      const candidateState = {
        outputFormat: getDefaultOutputFormat({ env }),
        symlinkMode: 'physical' as DuSymlinkMode,
        metric: 'logical-bytes' as DuMetric,
        excludePatterns: [] as string[],
        excludeFromFiles: [] as string[],
        logicalSizeOptionRequested: false,
        threshold: undefined,
      };
      for (const occurrence of candidate.occurrences) {
        const result = applyOccurrence({ occurrence, state: candidateState });
        if (!result.ok) return result.message;
      }
      return undefined;
    },
  });
  if (diagnostic !== undefined && !helpRequested && !semanticIssuePrecedesDiagnostic) {
    return {
      ok: false,
      message: `du: ${diagnostic.message}`,
    };
  }

  const state = {
    outputFormat: getDefaultOutputFormat({ env }),
    symlinkMode: 'physical' as DuSymlinkMode,
    metric: 'logical-bytes' as DuMetric,
    excludePatterns: [] as string[],
    excludeFromFiles: [] as string[],
    logicalSizeOptionRequested: false,
    threshold: undefined,
  };

  for (const occurrence of parsed.occurrences) {
    const result = applyOccurrence({ occurrence, state });
    if (!result.ok) {
      return result;
    }
  }

  const showAll = parsed.optionValues.showAll === true;
  const summarize = parsed.optionValues.summarize === true;
  const maxDepthValue = parsed.optionValues.maxDepth;
  const maxDepth = typeof maxDepthValue === 'number' ? maxDepthValue : undefined;
  const files0FromValue = parsed.optionValues.files0From;
  const files0From = typeof files0FromValue === 'string' ? files0FromValue : undefined;
  if (!helpRequested) {
    if (showAll && summarize) {
      return {
        ok: false,
        message: 'du: cannot both summarize and show all entries',
      };
    }
    if (summarize && maxDepth !== undefined && maxDepth !== 0) {
      return {
        ok: false,
        message: `du: summarizing conflicts with --max-depth=${maxDepth}`,
      };
    }
    if (files0From !== undefined && parsed.positionals.length > 0) {
      return {
        ok: false,
        message: `du: extra operand '${parsed.positionals[0]}'\nfile operands cannot be combined with --files0-from`,
      };
    }
  }

  return {
    ok: true,
    helpRequested,
    preHelpDiagnostics: helpRequested
      ? parsed.diagnostics.map(value => `du: ${value.message}`)
      : [],
    operands: parsed.positionals,
    options: {
      showAll,
      summarize,
      maxDepth,
      showTotal: parsed.optionValues.showTotal === true,
      separateDirs: parsed.optionValues.separateDirs === true,
      recordTerminator: parsed.optionValues.recordTerminator === 'null' ? '\0' : '\n',
      symlinkMode: state.symlinkMode,
      countLinks: parsed.optionValues.countLinks === true,
      metric: state.metric,
      outputFormat: state.outputFormat,
      threshold: state.threshold,
      files0From,
      excludePatterns: state.excludePatterns,
      excludeFromFiles: state.excludeFromFiles,
      logicalSizeOptionRequested: state.logicalSizeOptionRequested,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
