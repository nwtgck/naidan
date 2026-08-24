import { parseStandardArgv, type ArgvOptionOccurrence } from '@/features/wesh/argv';
import { STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
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
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^[+-]?\d+$/u.test(value)) {
    return { ok: false, message: `${option}: invalid numeric value '${value}'` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `${option}: numeric value is too large: '${value}'` };
  }
  if (parsed < 0) {
    return { ok: false, message: `${option}: invalid numeric value '${value}'` };
  }

  return { ok: true, value: parsed };
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

  if (value.length === 0) return { ok: true, value: 'simple' };

  const exact = aliases.find(alias => alias.name === value);
  if (exact !== undefined) return { ok: true, value: exact.style };

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
  value,
}: {
  value: string,
}): { ok: true, value: RejectFormat } | { ok: false, message: string } {
  switch (value) {
  case 'unified':
  case 'context':
    return { ok: true, value };
  default:
    return { ok: false, message: `invalid reject format '${value}'` };
  }
}

export const patchArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'display version information and exit', category: 'common' } },
    {
      kind: 'value',
      short: 'p',
      long: 'strip',
      key: 'stripCount',
      valueName: 'NUM',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseNonNegativeInteger({ option: '--strip', value }),
      help: { summary: 'strip NUM leading path components', valueName: 'NUM', category: 'common' },
    },
    {
      kind: 'value',
      short: 'F',
      long: 'fuzz',
      key: 'fuzz',
      valueName: 'NUM',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseNonNegativeInteger({ option: '--fuzz', value }),
      help: { summary: 'set the maximum fuzz factor', valueName: 'NUM', category: 'common' },
    },
    { kind: 'flag', short: 'l', long: 'ignore-whitespace', effects: [{ key: 'whitespaceMode', value: 'ignore-changes' }], help: { summary: 'ignore changes in spaces and tabs', category: 'common' } },
    { kind: 'flag', short: 'c', long: 'context', effects: [{ key: 'forcedFormat', value: 'context' }], help: { summary: 'interpret the patch as a context diff', category: 'advanced' } },
    { kind: 'flag', short: 'e', long: 'ed', effects: [{ key: 'forcedFormat', value: 'ed' }], help: { summary: 'interpret the patch as an ed script', category: 'advanced' } },
    { kind: 'flag', short: 'n', long: 'normal', effects: [{ key: 'forcedFormat', value: 'normal' }], help: { summary: 'interpret the patch as a normal diff', category: 'advanced' } },
    { kind: 'flag', short: 'u', long: 'unified', effects: [{ key: 'forcedFormat', value: 'unified' }], help: { summary: 'interpret the patch as a unified diff', category: 'advanced' } },
    { kind: 'flag', short: 'N', long: 'forward', effects: [{ key: 'forwardOnly', value: true }], help: { summary: 'ignore patches that appear reversed or applied', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'reverse', effects: [{ key: 'explicitReverse', value: true }], help: { summary: 'apply the patch in reverse', category: 'common' } },
    { kind: 'flag', short: 't', long: 'batch', effects: [{ key: 'batch', value: true }], help: { summary: 'ask no questions and assume reversed patches', category: 'advanced' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }], help: { summary: 'ask no questions and do not detect reversal', category: 'advanced' } },
    { kind: 'value', short: 'i', long: 'input', key: 'inputPath', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'read the patch from FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'o', long: 'output', key: 'outputPath', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'write patched output to FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'r', long: 'reject-file', key: 'rejectPath', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'write rejected hunks to FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'd', long: 'directory', key: 'directory', valueName: 'DIR', allowAttachedValue: true, parseValue: undefined, help: { summary: 'change to DIR before applying the patch', valueName: 'DIR', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'backup', effects: [{ key: 'backupAlways', value: true }], help: { summary: 'make a backup of each changed file', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'backup-if-mismatch', effects: [{ key: 'backupMismatchMode', value: 'enabled' }], help: { summary: 'back up files when offset, fuzz, or rejects occur', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'no-backup-if-mismatch', effects: [{ key: 'backupMismatchMode', value: 'disabled' }], help: { summary: 'do not back up files on mismatch', category: 'advanced' } },
    { kind: 'value', short: 'B', long: 'prefix', key: 'backupPrefix', valueName: 'PREFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'prepend PREFIX to backup file names', valueName: 'PREFIX', category: 'advanced' } },
    { kind: 'value', short: 'Y', long: 'basename-prefix', key: 'backupBasenamePrefix', valueName: 'PREFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'prepend PREFIX to backup basenames', valueName: 'PREFIX', category: 'advanced' } },
    { kind: 'value', short: 'z', long: 'suffix', key: 'backupSuffix', valueName: 'SUFFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use SUFFIX for simple backup files', valueName: 'SUFFIX', category: 'advanced' } },
    { kind: 'value', short: 'V', long: 'version-control', key: 'backupStyle', valueName: 'STYLE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'select simple, numbered, or existing backups', valueName: 'STYLE', category: 'advanced' } },
    { kind: 'flag', short: 'E', long: 'remove-empty-files', effects: [{ key: 'removeEmptyFiles', value: true }], help: { summary: 'remove output files that become empty', category: 'advanced' } },
    { kind: 'value', short: 'D', long: 'ifdef', key: 'ifdefName', valueName: 'NAME', allowAttachedValue: true, parseValue: undefined, help: { summary: 'mark changes with #ifdef NAME', valueName: 'NAME', category: 'advanced' } },
    { kind: 'flag', short: 's', long: 'quiet', effects: [{ key: 'quietMode', value: 'quiet' }], help: { summary: 'suppress normal progress messages', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quietMode', value: 'quiet' }], help: { summary: 'suppress normal progress messages', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'verbose', effects: [{ key: 'quietMode', value: 'verbose' }], help: { summary: 'print detailed progress messages', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'dry-run', effects: [{ key: 'dryRun', value: true }], help: { summary: 'check whether the patch applies without changing files', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'atomic', effects: [{ key: 'atomic', value: true }], help: { summary: 'apply all file changes only after every hunk applies', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'safe-paths', effects: [{ key: 'safePaths', value: true }], help: { summary: 'require explicit path stripping and disable basename fallback', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'posix', effects: [{ key: 'posix', value: true }], help: { summary: 'use POSIX-compatible behavior', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'binary', effects: [{ key: 'binary', value: true }], help: { summary: 'do not strip carriage returns from patch input', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'reject-format', key: 'rejectFormat', valueName: 'FORMAT', allowAttachedValue: false, parseValue: parseRejectFormat, help: { summary: 'write rejects in unified or context format', valueName: 'FORMAT', category: 'advanced' } },
    {
      kind: 'value',
      short: 'g',
      long: 'get',
      key: 'getMode',
      valueName: 'NUM',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseNonNegativeInteger({ option: '--get', value }),
      help: { summary: 'accept -g0; external revision control is unavailable', valueName: 'NUM', category: 'advanced' },
    },
    { kind: 'flag', short: 'T', long: 'set-time', effects: [{ key: 'unsupportedOption', value: '--set-time' }], help: { summary: 'unsupported: VFS timestamps cannot be set', category: 'advanced' } },
    { kind: 'flag', short: 'Z', long: 'set-utc', effects: [{ key: 'unsupportedOption', value: '--set-utc' }], help: { summary: 'unsupported: VFS timestamps cannot be set', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'merge', effects: [{ key: 'unsupportedOption', value: '--merge' }], help: { summary: 'unsupported: three-way merge is unavailable', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'follow-symlinks', effects: [{ key: 'unsupportedOption', value: '--follow-symlinks' }], help: { summary: 'unsupported for safety', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'read-only', effects: [{ key: 'unsupportedOption', value: '--read-only' }], help: { summary: 'unsupported: mount permissions are enforced', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'quoting-style', key: 'unsupportedOption', valueName: 'STYLE', allowAttachedValue: false, parseValue: ({ value }) => ({ ok: true, value: `--quoting-style=${value}` }), help: { summary: 'unsupported diagnostic formatting option', valueName: 'STYLE', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};


function isPatchDirectoryOccurrence(
  occurrence: ArgvOptionOccurrence,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> & { key: 'directory' } {
  return occurrence.kind === 'value' && occurrence.key === 'directory';
}

/**
 * GNU patch applies each -d/--directory option as getopt yields it. Therefore
 * a directory failure can outrank a later parser diagnostic or help/version
 * sentinel, and repeated relative directories are resolved cumulatively.
 * Reuse the standard parser on bounded prefixes instead of duplicating its
 * token-consumption rules. This path is only used when a directory option is
 * present in the full parse.
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
  if (!hasPotentialDirectoryOption) return [];

  const full = parseStandardArgv({ args, spec: patchArgvSpec });
  if (!full.occurrences.some((occurrence) => isPatchDirectoryOccurrence(occurrence))) {
    return [];
  }

  const directories: string[] = [];
  let observedDirectoryCount = 0;

  for (let end = 1; end <= args.length; end += 1) {
    const parsedPrefix = parseStandardArgv({ args: args.slice(0, end), spec: patchArgvSpec });
    const prefixDirectories = parsedPrefix.occurrences.filter((occurrence) => (
      isPatchDirectoryOccurrence(occurrence)
    ));
    while (observedDirectoryCount < prefixDirectories.length) {
      const occurrence = prefixDirectories[observedDirectoryCount];
      if (occurrence === undefined) break;
      directories.push(String(occurrence.value));
      observedDirectoryCount += 1;
    }

    const terminalDiagnostic = parsedPrefix.diagnostics.find((diagnostic) => (
      diagnostic.kind !== 'missing_option_value' || end === args.length
    ));
    if (terminalDiagnostic !== undefined) break;
    if (parsedPrefix.optionValues.help === true || parsedPrefix.optionValues.version === true) break;
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
    args: stopStandardArgvAtFirstEarlyExit({
      args,
      spec: patchArgvSpec,
      earlyExitOptions: STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS,
    }),
    spec: patchArgvSpec,
  });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    return { kind: 'error', message: `patch: ${diagnostic.message}` };
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
