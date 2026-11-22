import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvUsageSummary,
  HELP_VERSION_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type ArgvOptionDefinition,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';
import type {
  BackupStyle,
  PatchFormat,
  PatchOptions,
  RejectFormat,
  ResolvedPatchOperands,
} from './types';

function parseNonNegativeInteger({
  option,
  value,
}: {
  option: string,
  value: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  if (!/^[+-]?\d+$/u.test(value)) {
    return { kind: 'invalid', message: `${option}: invalid numeric value '${value}'` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { kind: 'invalid', message: `${option}: numeric value is too large: '${value}'` };
  }
  if (parsed < 0) {
    return { kind: 'invalid', message: `${option}: invalid numeric value '${value}'` };
  }

  return { kind: 'parsed', value: parsed };
}

export function parsePatchBackupStyle({
  value,
}: {
  value: string,
}): { ok: true, value: BackupStyle } | { ok: false, message: string } {
  const aliases = [
    { name: 'none', style: 'numbered' },
    { name: 'off', style: 'numbered' },
    { name: 'simple', style: 'simple' },
    { name: 'never', style: 'simple' },
    { name: 'numbered', style: 'numbered' },
    { name: 't', style: 'numbered' },
    { name: 'existing', style: 'existing' },
    { name: 'nil', style: 'existing' },
  ] as const satisfies readonly { name: string, style: BackupStyle }[];

  if (value.length === 0) {
    return { ok: true, value: 'simple' };
  }

  const exact = aliases.find(alias => alias.name === value);
  if (exact !== undefined) {
    return { ok: true, value: exact.style };
  }

  const prefixMatches = aliases.filter(alias => alias.name.startsWith(value));
  if (prefixMatches.length === 1) {
    return { ok: true, value: prefixMatches[0]!.style };
  }
  if (prefixMatches.length > 1) {
    return { ok: false, message: `ambiguous version control style '${value}'` };
  }
  return { ok: false, message: `invalid version control style '${value}'` };
}


function parseRejectFormat({
  rawValue,
}: {
  rawValue: string,
}): { kind: 'parsed', value: RejectFormat } | { kind: 'invalid', message: string } {
  switch (rawValue) {
  case 'unified':
  case 'context':
    return { kind: 'parsed', value: rawValue };
  default:
    return { kind: 'invalid', message: `invalid reject format '${rawValue}'` };
  }
}

// Keep the legacy long flags accepting and ignoring an inline value.
// No following operand is consumed by these forms.
const patchOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'optional-inline' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'version', value: true }] },
    forms: [{ kind: 'long', name: 'version', value: { kind: 'optional-inline' } }],
    summary: 'display version information and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'stripCount', parse: ({ rawValue: value }) => parseNonNegativeInteger({ option: '--strip', value }) },
    forms: [
      { kind: 'short', name: 'p', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } },
      { kind: 'long', name: 'strip', value: { kind: 'required', missingValueName: 'NUM' } },
    ],
    summary: 'strip NUM leading path components',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'fuzz', parse: ({ rawValue: value }) => parseNonNegativeInteger({ option: '--fuzz', value }) },
    forms: [
      { kind: 'short', name: 'F', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } },
      { kind: 'long', name: 'fuzz', value: { kind: 'required', missingValueName: 'NUM' } },
    ],
    summary: 'set the maximum fuzz factor',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'whitespaceMode', value: 'ignore-changes' }] },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-whitespace', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore changes in spaces and tabs',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'forcedFormat', value: 'context' }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'context', value: { kind: 'optional-inline' } },
    ],
    summary: 'interpret the patch as a context diff',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'forcedFormat', value: 'ed' }] },
    forms: [
      { kind: 'short', name: 'e', value: { kind: 'none' } },
      { kind: 'long', name: 'ed', value: { kind: 'optional-inline' } },
    ],
    summary: 'interpret the patch as an ed script',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'forcedFormat', value: 'normal' }] },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'long', name: 'normal', value: { kind: 'optional-inline' } },
    ],
    summary: 'interpret the patch as a normal diff',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'forcedFormat', value: 'unified' }] },
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'long', name: 'unified', value: { kind: 'optional-inline' } },
    ],
    summary: 'interpret the patch as a unified diff',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'forwardOnly', value: true }] },
    forms: [
      { kind: 'short', name: 'N', value: { kind: 'none' } },
      { kind: 'long', name: 'forward', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore patches that appear reversed or applied',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'explicitReverse', value: true }] },
    forms: [
      { kind: 'short', name: 'R', value: { kind: 'none' } },
      { kind: 'long', name: 'reverse', value: { kind: 'optional-inline' } },
    ],
    summary: 'apply the patch in reverse',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'batch', value: true }] },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'none' } },
      { kind: 'long', name: 'batch', value: { kind: 'optional-inline' } },
    ],
    summary: 'ask no questions and assume reversed patches',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'force', value: { kind: 'optional-inline' } },
    ],
    summary: 'ask no questions and do not detect reversal',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'inputPath', parse: undefined },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'input', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'read the patch from FILE',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'outputPath', parse: undefined },
    forms: [
      { kind: 'short', name: 'o', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'output', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'write patched output to FILE',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'rejectPath', parse: undefined },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'reject-file', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'write rejected hunks to FILE',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'directory', parse: undefined },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'required-attached-or-following', missingValueName: 'DIR' } },
      { kind: 'long', name: 'directory', value: { kind: 'required', missingValueName: 'DIR' } },
    ],
    summary: 'change to DIR before applying the patch',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'backupAlways', value: true }] },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'backup', value: { kind: 'optional-inline' } },
    ],
    summary: 'make a backup of each changed file',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'backupMismatchMode', value: 'enabled' }] },
    forms: [{ kind: 'long', name: 'backup-if-mismatch', value: { kind: 'optional-inline' } }],
    summary: 'back up files when offset, fuzz, or rejects occur',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'backupMismatchMode', value: 'disabled' }] },
    forms: [{ kind: 'long', name: 'no-backup-if-mismatch', value: { kind: 'optional-inline' } }],
    summary: 'do not back up files on mismatch',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'backupPrefix', parse: undefined },
    forms: [
      { kind: 'short', name: 'B', value: { kind: 'required-attached-or-following', missingValueName: 'PREFIX' } },
      { kind: 'long', name: 'prefix', value: { kind: 'required', missingValueName: 'PREFIX' } },
    ],
    summary: 'prepend PREFIX to backup file names',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'backupBasenamePrefix', parse: undefined },
    forms: [
      { kind: 'short', name: 'Y', value: { kind: 'required-attached-or-following', missingValueName: 'PREFIX' } },
      { kind: 'long', name: 'basename-prefix', value: { kind: 'required', missingValueName: 'PREFIX' } },
    ],
    summary: 'prepend PREFIX to backup basenames',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'backupSuffix', parse: undefined },
    forms: [
      { kind: 'short', name: 'z', value: { kind: 'required-attached-or-following', missingValueName: 'SUFFIX' } },
      { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUFFIX' } },
    ],
    summary: 'use SUFFIX for simple backup files',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'backupStyle', parse: undefined },
    forms: [
      { kind: 'short', name: 'V', value: { kind: 'required-attached-or-following', missingValueName: 'STYLE' } },
      { kind: 'long', name: 'version-control', value: { kind: 'required', missingValueName: 'STYLE' } },
    ],
    summary: 'select simple, numbered, or existing backups',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'removeEmptyFiles', value: true }] },
    forms: [
      { kind: 'short', name: 'E', value: { kind: 'none' } },
      { kind: 'long', name: 'remove-empty-files', value: { kind: 'optional-inline' } },
    ],
    summary: 'remove output files that become empty',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'ifdefName', parse: undefined },
    forms: [
      { kind: 'short', name: 'D', value: { kind: 'required-attached-or-following', missingValueName: 'NAME' } },
      { kind: 'long', name: 'ifdef', value: { kind: 'required', missingValueName: 'NAME' } },
    ],
    summary: 'mark changes with #ifdef NAME',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quietMode', value: 'quiet' }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'quiet', value: { kind: 'optional-inline' } },
    ],
    summary: 'suppress normal progress messages',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quietMode', value: 'quiet' }] },
    forms: [{ kind: 'long', name: 'silent', value: { kind: 'optional-inline' } }],
    summary: 'suppress normal progress messages',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quietMode', value: 'verbose' }] },
    forms: [{ kind: 'long', name: 'verbose', value: { kind: 'optional-inline' } }],
    summary: 'print detailed progress messages',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'dryRun', value: true }] },
    forms: [{ kind: 'long', name: 'dry-run', value: { kind: 'optional-inline' } }],
    summary: 'check whether the patch applies without changing files',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'atomic', value: true }] },
    forms: [{ kind: 'long', name: 'atomic', value: { kind: 'optional-inline' } }],
    summary: 'apply all file changes only after every hunk applies',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'safePaths', value: true }] },
    forms: [{ kind: 'long', name: 'safe-paths', value: { kind: 'optional-inline' } }],
    summary: 'require explicit path stripping and disable basename fallback',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'posix', value: true }] },
    forms: [{ kind: 'long', name: 'posix', value: { kind: 'optional-inline' } }],
    summary: 'use POSIX-compatible behavior',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'binary', value: true }] },
    forms: [{ kind: 'long', name: 'binary', value: { kind: 'optional-inline' } }],
    summary: 'do not strip carriage returns from patch input',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'rejectFormat', parse: parseRejectFormat },
    forms: [{ kind: 'long', name: 'reject-format', value: { kind: 'required', missingValueName: 'FORMAT' } }],
    summary: 'write rejects in unified or context format',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'getMode', parse: ({ rawValue: value }) => parseNonNegativeInteger({ option: '--get', value }) },
    forms: [
      { kind: 'short', name: 'g', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } },
      { kind: 'long', name: 'get', value: { kind: 'required', missingValueName: 'NUM' } },
    ],
    summary: 'accept -g0; external revision control is unavailable',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unsupportedOption', value: '--set-time' }] },
    forms: [
      { kind: 'short', name: 'T', value: { kind: 'none' } },
      { kind: 'long', name: 'set-time', value: { kind: 'optional-inline' } },
    ],
    summary: 'unsupported: VFS timestamps cannot be set',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unsupportedOption', value: '--set-utc' }] },
    forms: [
      { kind: 'short', name: 'Z', value: { kind: 'none' } },
      { kind: 'long', name: 'set-utc', value: { kind: 'optional-inline' } },
    ],
    summary: 'unsupported: VFS timestamps cannot be set',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unsupportedOption', value: '--merge' }] },
    forms: [{ kind: 'long', name: 'merge', value: { kind: 'optional-inline' } }],
    summary: 'unsupported: three-way merge is unavailable',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unsupportedOption', value: '--follow-symlinks' }] },
    forms: [{ kind: 'long', name: 'follow-symlinks', value: { kind: 'optional-inline' } }],
    summary: 'unsupported for safety',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unsupportedOption', value: '--read-only' }] },
    forms: [{ kind: 'long', name: 'read-only', value: { kind: 'optional-inline' } }],
    summary: 'unsupported: mount permissions are enforced',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'unsupportedOption', parse: ({ rawValue }) => ({ kind: 'parsed', value: `--quoting-style=${rawValue}` }) },
    forms: [{ kind: 'long', name: 'quoting-style', value: { kind: 'required', missingValueName: 'STYLE' } }],
    summary: 'unsupported diagnostic formatting option',
    category: 'advanced',
  },
] as const satisfies readonly (ArgvOptionDefinition<StandardArgvAction<never>> & {
  summary: string,
  category: 'common' | 'advanced',
  valueName?: string,
})[];

const patchArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: patchOptions, nonExecutableLongOptions: [] });
export const patchArgvHelp = defineArgvHelpPresentation({ catalog: patchArgvCatalog, rows: patchOptions });
// The existing usage diagnostic ends with a help hint even though help is also in its option list.
export const patchArgvUsageSummary = `${formatArgvUsageSummary({ presentation: patchArgvHelp })}, --help`;
const patchArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};


/**
 * GNU patch applies each -d/--directory option as getopt yields it. Therefore
 * a directory failure can outrank a later parser diagnostic or help/version
 * sentinel, and repeated relative directories are resolved cumulatively.
 * Use only the token claims preceding the first terminal condition.
 */
export function patchDirectoryOperandsBeforeTerminal({
  args,
}: {
  args: string[],
}): string[] {
  const hasPotentialDirectoryOption = args.some((token) => (
    token === '--directory'
    || token.startsWith('--directory=')
    || (token.startsWith('-') && !token.startsWith('--') && token.slice(1).includes('d'))
  ));
  if (!hasPotentialDirectoryOption) {
    return [];
  }

  const parsed = parseStandardArgv({ args, catalog: patchArgvCatalog, policy: patchArgvPolicy });
  const firstDiagnostic = parsed.diagnostics[0];
  const directories: string[] = [];
  for (const { semantic, argvIndex, tokenStart, value } of parsed.occurrences ?? []) {
    if (firstDiagnostic !== undefined && (argvIndex > firstDiagnostic.argvIndex
      || (argvIndex === firstDiagnostic.argvIndex && tokenStart >= firstDiagnostic.tokenOffset))) {
      break;
    }
    if (semantic.kind === 'effects' && semantic.effects.some(({ key }) => key === 'help' || key === 'version')) {
      break;
    }
    if (semantic.kind === 'required-value' && semantic.key === 'directory' && value.kind !== 'none') {
      directories.push(value.rawValue);
    }
  }

  return directories;
}

export type ParsePatchArgvResult =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error', message: string }
  | { kind: 'ok', options: PatchOptions, operands: ResolvedPatchOperands };

export function parsePatchArgv({
  args,
}: {
  args: string[],
}): ParsePatchArgvResult {
  const parsed = parseStandardArgv({
    args: stopArgvAtFirstEarlyExit({
      args,
      catalog: patchArgvCatalog,
      policy: patchArgvPolicy,
      earlyExitOptions: HELP_VERSION_EARLY_EXIT_OPTIONS,
    }),
    catalog: patchArgvCatalog,
    policy: patchArgvPolicy,
  });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    const message = (() => {
      switch (diagnostic.kind) {
      case 'unknown_long_option':
        return `unrecognized option '${diagnostic.option.split('=', 1)[0]}'`;
      case 'unknown_short_option':
      case 'ambiguous_long_option':
      case 'missing_option_value':
      case 'unexpected_option_value':
      case 'invalid_option_value':
        return diagnostic.message;
      default: {
        const _ex: never = diagnostic;
        throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    return { kind: 'error', message: `patch: ${message}` };
  }

  if (parsed.optionValues.help === true) {
    return { kind: 'help' };
  }

  if (parsed.optionValues.version === true) {
    return { kind: 'version' };
  }

  if (parsed.positionals.length > 2) {
    return { kind: 'error', message: `patch: extra operand '${parsed.positionals[2]}'` };
  }

  const originalPath = parsed.positionals[0];
  const positionalPatchPath = parsed.positionals[1];
  const inputPath = typeof parsed.optionValues.inputPath === 'string'
    ? parsed.optionValues.inputPath
    : undefined;

  if (inputPath !== undefined && positionalPatchPath !== undefined) {
    return { kind: 'error', message: 'patch: patch input was specified both with -i and as an operand' };
  }

  const forcedFormat = typeof parsed.optionValues.forcedFormat === 'string'
    ? parsed.optionValues.forcedFormat as PatchFormat
    : undefined;
  const unsupportedOption = typeof parsed.optionValues.unsupportedOption === 'string'
    ? parsed.optionValues.unsupportedOption
    : undefined;
  const getMode = typeof parsed.optionValues.getMode === 'number'
    ? parsed.optionValues.getMode
    : undefined;
  const rawBackupStyle = typeof parsed.optionValues.backupStyle === 'string'
    ? parsed.optionValues.backupStyle
    : undefined;
  const parsedBackupStyle = rawBackupStyle === undefined
    ? { ok: true as const, value: 'simple' as const }
    : parsePatchBackupStyle({ value: rawBackupStyle });
  if (!parsedBackupStyle.ok) {
    return { kind: 'error', message: `patch: ${parsedBackupStyle.message}` };
  }

  if (getMode !== undefined && getMode !== 0) {
    return { kind: 'error', message: 'patch: external revision control access is not available; only -g0 is supported' };
  }

  const options: PatchOptions = {
    stripCount: typeof parsed.optionValues.stripCount === 'number' ? parsed.optionValues.stripCount : undefined,
    fuzz: typeof parsed.optionValues.fuzz === 'number' ? parsed.optionValues.fuzz : 2,
    whitespaceMode: parsed.optionValues.whitespaceMode === 'ignore-changes' ? 'ignore-changes' : 'exact',
    forcedFormat,
    explicitReverse: parsed.optionValues.explicitReverse === true,
    forwardOnly: parsed.optionValues.forwardOnly === true,
    batch: parsed.optionValues.batch === true,
    force: parsed.optionValues.force === true,
    inputPath,
    outputPath: typeof parsed.optionValues.outputPath === 'string' ? parsed.optionValues.outputPath : undefined,
    rejectPath: typeof parsed.optionValues.rejectPath === 'string' ? parsed.optionValues.rejectPath : undefined,
    backupAlways: parsed.optionValues.backupAlways === true,
    backupMismatchMode: parsed.optionValues.backupMismatchMode === 'enabled' || parsed.optionValues.backupMismatchMode === 'disabled'
      ? parsed.optionValues.backupMismatchMode
      : 'default',
    backupPrefix: typeof parsed.optionValues.backupPrefix === 'string' ? parsed.optionValues.backupPrefix : undefined,
    backupBasenamePrefix: typeof parsed.optionValues.backupBasenamePrefix === 'string' ? parsed.optionValues.backupBasenamePrefix : undefined,
    backupSuffix: typeof parsed.optionValues.backupSuffix === 'string' ? parsed.optionValues.backupSuffix : '.orig',
    backupSuffixExplicit: typeof parsed.optionValues.backupSuffix === 'string',
    backupStyle: parsedBackupStyle.value,
    backupStyleExplicit: rawBackupStyle !== undefined,
    removeEmptyFiles: parsed.optionValues.removeEmptyFiles === true,
    ifdefName: typeof parsed.optionValues.ifdefName === 'string' ? parsed.optionValues.ifdefName : undefined,
    quietMode: parsed.optionValues.quietMode === 'quiet' || parsed.optionValues.quietMode === 'verbose'
      ? parsed.optionValues.quietMode
      : 'normal',
    dryRun: parsed.optionValues.dryRun === true,
    atomic: parsed.optionValues.atomic === true,
    safePaths: parsed.optionValues.safePaths === true,
    posix: parsed.optionValues.posix === true,
    binary: parsed.optionValues.binary === true,
    rejectFormat: parsed.optionValues.rejectFormat === 'unified' || parsed.optionValues.rejectFormat === 'context'
      ? parsed.optionValues.rejectFormat
      : undefined,
    getMode,
    unsupportedOption,
  };

  return {
    kind: 'ok',
    options,
    operands: {
      originalPath,
      patchPath: inputPath ?? positionalPatchPath,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
