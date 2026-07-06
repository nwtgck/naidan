import { parseStandardArgv } from '@/features/wesh/argv';
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
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `${option}: invalid numeric value '${value}'` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `${option}: numeric value is too large: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseBackupStyle({
  value,
}: {
  value: string,
}): { ok: true, value: BackupStyle } | { ok: false, message: string } {
  switch (value) {
  case 'simple':
  case 'never':
    return { ok: true, value: 'simple' };
  case 'numbered':
  case 't':
    return { ok: true, value: 'numbered' };
  case 'existing':
  case 'nil':
    return { ok: true, value: 'existing' };
  default:
    return { ok: false, message: `invalid version control style '${value}'` };
  }
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
    { kind: 'flag', short: 'N', long: 'forward', effects: [{ key: 'directionMode', value: 'forward-only' }], help: { summary: 'ignore patches that appear reversed or applied', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'reverse', effects: [{ key: 'directionMode', value: 'reverse' }], help: { summary: 'apply the patch in reverse', category: 'common' } },
    { kind: 'flag', short: 't', long: 'batch', effects: [{ key: 'reverseDecisionMode', value: 'assume-reverse' }], help: { summary: 'ask no questions and assume reversed patches', category: 'advanced' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'reverseDecisionMode', value: 'force-forward' }], help: { summary: 'ask no questions and do not detect reversal', category: 'advanced' } },
    { kind: 'value', short: 'i', long: 'input', key: 'inputPath', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'read the patch from FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'o', long: 'output', key: 'outputPath', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'write patched output to FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'r', long: 'reject-file', key: 'rejectPath', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'write rejected hunks to FILE', valueName: 'FILE', category: 'common' } },
    { kind: 'value', short: 'd', long: 'directory', key: 'directory', valueName: 'DIR', allowAttachedValue: false, parseValue: undefined, help: { summary: 'change to DIR before applying the patch', valueName: 'DIR', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'backup', effects: [{ key: 'backupMode', value: 'always' }], help: { summary: 'make a backup of each changed file', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'backup-if-mismatch', effects: [{ key: 'backupMode', value: 'if-mismatch' }], help: { summary: 'back up files when offset, fuzz, or rejects occur', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'no-backup-if-mismatch', effects: [{ key: 'backupMode', value: 'never' }], help: { summary: 'do not back up files on mismatch', category: 'advanced' } },
    { kind: 'value', short: 'B', long: 'prefix', key: 'backupPrefix', valueName: 'PREFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'prepend PREFIX to backup file names', valueName: 'PREFIX', category: 'advanced' } },
    { kind: 'value', short: 'Y', long: 'basename-prefix', key: 'backupBasenamePrefix', valueName: 'PREFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'prepend PREFIX to backup basenames', valueName: 'PREFIX', category: 'advanced' } },
    { kind: 'value', short: 'z', long: 'suffix', key: 'backupSuffix', valueName: 'SUFFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use SUFFIX for simple backup files', valueName: 'SUFFIX', category: 'advanced' } },
    { kind: 'value', short: 'V', long: 'version-control', key: 'backupStyle', valueName: 'STYLE', allowAttachedValue: true, parseValue: parseBackupStyle, help: { summary: 'select simple, numbered, or existing backups', valueName: 'STYLE', category: 'advanced' } },
    { kind: 'flag', short: 'E', long: 'remove-empty-files', effects: [{ key: 'removeEmptyFiles', value: true }], help: { summary: 'remove output files that become empty', category: 'advanced' } },
    { kind: 'value', short: 'D', long: 'ifdef', key: 'ifdefName', valueName: 'NAME', allowAttachedValue: true, parseValue: undefined, help: { summary: 'mark changes with #ifdef NAME', valueName: 'NAME', category: 'advanced' } },
    { kind: 'flag', short: 's', long: 'quiet', effects: [{ key: 'quietMode', value: 'quiet' }], help: { summary: 'suppress normal progress messages', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quietMode', value: 'quiet' }], help: { summary: 'suppress normal progress messages', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'verbose', effects: [{ key: 'quietMode', value: 'verbose' }], help: { summary: 'print detailed progress messages', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'dry-run', effects: [{ key: 'dryRun', value: true }], help: { summary: 'check whether the patch applies without changing files', category: 'common' } },
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
  const parsed = parseStandardArgv({ args, spec: patchArgvSpec });
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

  if (getMode !== undefined && getMode !== 0) {
    return { kind: 'error', message: 'patch: external revision control access is not available; only -g0 is supported' };
  }

  const options: PatchOptions = {
    stripCount: typeof parsed.optionValues.stripCount === 'number' ? parsed.optionValues.stripCount : undefined,
    fuzz: typeof parsed.optionValues.fuzz === 'number' ? parsed.optionValues.fuzz : 2,
    whitespaceMode: parsed.optionValues.whitespaceMode === 'ignore-changes' ? 'ignore-changes' : 'exact',
    forcedFormat,
    directionMode: parsed.optionValues.directionMode === 'forward-only' || parsed.optionValues.directionMode === 'reverse'
      ? parsed.optionValues.directionMode
      : 'auto',
    reverseDecisionMode: parsed.optionValues.reverseDecisionMode === 'assume-reverse' || parsed.optionValues.reverseDecisionMode === 'force-forward'
      ? parsed.optionValues.reverseDecisionMode
      : 'safe-skip',
    inputPath,
    outputPath: typeof parsed.optionValues.outputPath === 'string' ? parsed.optionValues.outputPath : undefined,
    rejectPath: typeof parsed.optionValues.rejectPath === 'string' ? parsed.optionValues.rejectPath : undefined,
    directory: typeof parsed.optionValues.directory === 'string' ? parsed.optionValues.directory : undefined,
    backupMode: parsed.optionValues.backupMode === 'always' || parsed.optionValues.backupMode === 'never'
      ? parsed.optionValues.backupMode
      : 'if-mismatch',
    backupPrefix: typeof parsed.optionValues.backupPrefix === 'string' ? parsed.optionValues.backupPrefix : undefined,
    backupBasenamePrefix: typeof parsed.optionValues.backupBasenamePrefix === 'string' ? parsed.optionValues.backupBasenamePrefix : undefined,
    backupSuffix: typeof parsed.optionValues.backupSuffix === 'string' ? parsed.optionValues.backupSuffix : '.orig',
    backupStyle: parsed.optionValues.backupStyle === 'numbered' || parsed.optionValues.backupStyle === 'existing'
      ? parsed.optionValues.backupStyle
      : 'simple',
    removeEmptyFiles: parsed.optionValues.removeEmptyFiles === true,
    ifdefName: typeof parsed.optionValues.ifdefName === 'string' ? parsed.optionValues.ifdefName : undefined,
    quietMode: parsed.optionValues.quietMode === 'quiet' || parsed.optionValues.quietMode === 'verbose'
      ? parsed.optionValues.quietMode
      : 'normal',
    dryRun: parsed.optionValues.dryRun === true,
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
