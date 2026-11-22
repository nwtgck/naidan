import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  parseStandardArgv,
  type ParsedStandardArgv,
  type StandardArgvAction,
  type StandardArgvOccurrence,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
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
      operands: readonly string[],
      helpRequested: false,
    }
  | {
      ok: true,
      helpRequested: true,
      preHelpDiagnostics: readonly string[],
      excludePatterns: readonly string[],
      excludeFromFiles: readonly string[],
    }
  | {
      ok: false,
      message: string,
    };

function parseNonNegativeInteger({ rawValue }: { rawValue: string }):
  | { kind: 'parsed', value: number }
  | { kind: 'invalid', message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value: rawValue });
  if (!/^\+?[0-9]+$/u.test(numericText)) {
    return {
      kind: 'invalid',
      message: `invalid maximum depth '${rawValue}'`,
    };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed)) {
    return {
      kind: 'invalid',
      message: `maximum depth is too large: '${rawValue}'`,
    };
  }

  return { kind: 'parsed', value: parsed };
}

const duOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'recordTerminator', value: 'null' }] },
    forms: [
      { kind: 'short', name: '0', value: { kind: 'none' } },
      { kind: 'long', name: 'null', value: { kind: 'none' } },
    ],
    summary: 'end each output line with NUL, not newline',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showAll', value: true }] },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'none' } },
      { kind: 'long', name: 'all', value: { kind: 'none' } },
    ],
    summary: 'write counts for all files, not just directories',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'apparentSize', value: true }] },
    forms: [{ kind: 'long', name: 'apparent-size', value: { kind: 'none' } }],
    summary: 'use logical file sizes (the Wesh default)',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputMode', value: 'bytes' }] },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'bytes', value: { kind: 'none' } },
    ],
    summary: 'equivalent to --apparent-size --block-size=1',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'blockSize', parse: undefined },
    forms: [
      { kind: 'short', name: 'B', value: { kind: 'required-attached-or-following', missingValueName: 'SIZE' } },
      { kind: 'long', name: 'block-size', value: { kind: 'required', missingValueName: 'SIZE' } },
    ],
    summary: 'scale sizes by SIZE before printing',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showTotal', value: true }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'total', value: { kind: 'none' } },
    ],
    summary: 'produce a grand total',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'command-line' }] },
    forms: [
      { kind: 'short', name: 'D', value: { kind: 'none' } },
      { kind: 'long', name: 'dereference-args', value: { kind: 'none' } },
    ],
    summary: 'dereference only command-line symbolic links',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'command-line' }] },
    forms: [{ kind: 'short', name: 'H', value: { kind: 'none' } }],
    summary: 'equivalent to --dereference-args',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'maxDepth', parse: parseNonNegativeInteger },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'required-attached-or-following', missingValueName: 'N' } },
      { kind: 'long', name: 'max-depth', value: { kind: 'required', missingValueName: 'N' } },
    ],
    summary: 'print entries only if they are N or fewer levels below an argument',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'files0From', parse: undefined },
    forms: [{ kind: 'long', name: 'files0-from', value: { kind: 'required', missingValueName: 'FILE' } }],
    summary: 'read NUL-terminated file names from FILE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputMode', value: 'human-1024' }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'human-readable', value: { kind: 'none' } },
    ],
    summary: 'print sizes in powers of 1024',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputMode', value: 'human-1000' }] },
    forms: [{ kind: 'long', name: 'si', value: { kind: 'none' } }],
    summary: 'print sizes in powers of 1000',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'metric', value: 'inodes' }] },
    forms: [{ kind: 'long', name: 'inodes', value: { kind: 'none' } }],
    summary: 'list entry counts instead of byte usage',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputMode', value: 'kibibytes' }] },
    forms: [{ kind: 'short', name: 'k', value: { kind: 'none' } }],
    summary: 'like --block-size=1K',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'logical' }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'dereference', value: { kind: 'none' } },
    ],
    summary: 'dereference all symbolic links',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'countLinks', value: true }] },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'none' } },
      { kind: 'long', name: 'count-links', value: { kind: 'none' } },
    ],
    summary: 'count repeated resolved entries multiple times',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputMode', value: 'mebibytes' }] },
    forms: [{ kind: 'short', name: 'm', value: { kind: 'none' } }],
    summary: 'like --block-size=1M',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkMode', value: 'physical' }] },
    forms: [
      { kind: 'short', name: 'P', value: { kind: 'none' } },
      { kind: 'long', name: 'no-dereference', value: { kind: 'none' } },
    ],
    summary: 'do not follow symbolic links (the default)',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'separateDirs', value: true }] },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'none' } },
      { kind: 'long', name: 'separate-dirs', value: { kind: 'none' } },
    ],
    summary: 'for directories, exclude subdirectory sizes from displayed values',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'summarize', value: true }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'summarize', value: { kind: 'none' } },
    ],
    summary: 'display only a total for each argument',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'threshold', parse: undefined },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'SIZE' } },
      { kind: 'long', name: 'threshold', value: { kind: 'required', missingValueName: 'SIZE' } },
    ],
    summary: 'exclude entries outside the SIZE threshold',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'excludeFrom', parse: undefined },
    forms: [
      { kind: 'short', name: 'X', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'exclude-from', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'exclude entries matching patterns from FILE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'excludePattern', parse: undefined },
    forms: [{ kind: 'long', name: 'exclude', value: { kind: 'required', missingValueName: 'PATTERN' } }],
    summary: 'exclude entries matching PATTERN',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const duArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: duOptions,
  nonExecutableLongOptions: [],
});
export const duArgvHelp = defineArgvHelpPresentation({ catalog: duArgvCatalog, rows: duOptions });
const duArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

function getDefaultOutputFormat({ env }: { env: ReadonlyMap<string, string> }): DuOutputFormat {
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
  args,
  state,
}: {
  occurrence: StandardArgvOccurrence<StandardArgvAction<never>>,
  args: readonly string[],
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
  switch (occurrence.semantic.kind) {
  case 'effects': {
    for (const effect of occurrence.semantic.effects) {
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
  case 'required-value': {
    const { value } = occurrence;
    const rawValue = (() => {
      switch (value.kind) {
      case 'inline':
      case 'next-argv':
        return value.rawValue;
      case 'none':
        throw new Error('Missing value for du option occurrence');
      default: {
        const _ex: never = value;
        throw new Error(`Unhandled du option value: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    switch (occurrence.semantic.key) {
    case 'blockSize': {
      const parsed = parseDuBlockSize({ value: rawValue });
      if (!parsed.ok) {
        return { ok: false, message: `du: ${parsed.message}` };
      }
      state.outputFormat = parsed.outputFormat;
      return { ok: true };
    }
    case 'excludePattern':
      state.excludePatterns.push(rawValue);
      return { ok: true };
    case 'excludeFrom':
      state.excludeFromFiles.push(rawValue);
      return { ok: true };
    case 'threshold': {
      const parsed = parseDuThreshold({ value: rawValue });
      if (!parsed.ok) {
        const option = args[occurrence.argvIndex]?.startsWith('--') ? '--threshold' : '-t';
        return {
          ok: false,
          message: `du: invalid ${option} argument '${rawValue}'`,
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
  }
  case 'deferred':
    throw new Error('Unexpected deferred du option');
  default: {
    const _ex: never = occurrence.semantic;
    throw new Error(`Unhandled du option occurrence: ${_ex}`);
  }
  }
}

function parseDuArgv({ args }: { args: readonly string[] }): {
  parsed: ParsedStandardArgv<never>,
  helpRequested: boolean,
} {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--help') {
      continue;
    }
    const prefix = args.slice(0, index + 1);
    const parsed = parseStandardArgv({ args: prefix, catalog: duArgvCatalog, policy: duArgvPolicy });
    // GNU du reports some diagnostics and still processes a later --help.
    // Only a recorded occurrence makes this token a help option.
    if (parsed.occurrences?.some(occurrence => occurrence.argvIndex === index)) {
      return { parsed, helpRequested: true };
    }
  }
  return {
    parsed: parseStandardArgv({ args, catalog: duArgvCatalog, policy: duArgvPolicy }),
    helpRequested: false,
  };
}

export function parseDuOptions({
  args,
  env,
}: {
  args: readonly string[],
  env: ReadonlyMap<string, string>,
}): DuOptionsParseResult {
  const { parsed, helpRequested } = parseDuArgv({ args });
  const diagnostic = parsed.diagnostics[0];

  const state = {
    outputFormat: getDefaultOutputFormat({ env }),
    symlinkMode: 'physical' as DuSymlinkMode,
    metric: 'logical-bytes' as DuMetric,
    excludePatterns: [] as string[],
    excludeFromFiles: [] as string[],
    logicalSizeOptionRequested: false,
    threshold: undefined,
  };

  for (const occurrence of parsed.occurrences ?? []) {
    if (!helpRequested && diagnostic !== undefined && (
      diagnostic.argvIndex < occurrence.argvIndex
      || (diagnostic.argvIndex === occurrence.argvIndex && diagnostic.tokenOffset <= occurrence.tokenStart)
    )) {
      break;
    }
    const result = applyOccurrence({ occurrence, args, state });
    if (!result.ok) {
      return result;
    }
  }

  if (helpRequested) {
    return {
      ok: true,
      helpRequested: true,
      preHelpDiagnostics: parsed.diagnostics.map(value => `du: ${value.message}`),
      excludePatterns: state.excludePatterns,
      excludeFromFiles: state.excludeFromFiles,
    };
  }
  if (diagnostic !== undefined) {
    return { ok: false, message: `du: ${diagnostic.message}` };
  }

  const showAll = parsed.optionValues.showAll === true;
  const summarize = parsed.optionValues.summarize === true;
  const maxDepthValue = parsed.optionValues.maxDepth;
  const maxDepth = typeof maxDepthValue === 'number' ? maxDepthValue : undefined;
  const files0FromValue = parsed.optionValues.files0From;
  const files0From = typeof files0FromValue === 'string' ? files0FromValue : undefined;
  if (showAll && summarize) {
    return { ok: false, message: 'du: cannot both summarize and show all entries' };
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

  return {
    ok: true,
    helpRequested: false,
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
