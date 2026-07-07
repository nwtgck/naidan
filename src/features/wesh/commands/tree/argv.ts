import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { compileTreePattern } from './pattern';
import type { TreeCharset, TreeGroupingMode, TreeOptions, TreeSortMode } from './types';

function parsePositiveInteger({ value }: { value: string }) {
  if (!/^\d+$/.test(value)) {
    return { ok: false as const, message: `invalid integer '${value}'` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false as const, message: `invalid level '${value}'` };
  }
  return { ok: true as const, value: parsed };
}

function parseNonNegativeInteger({ value }: { value: string }) {
  if (!/^\d+$/.test(value)) {
    return { ok: false as const, message: `invalid integer '${value}'` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false as const, message: `invalid count '${value}'` };
  }
  return { ok: true as const, value: parsed };
}

function parseSortMode({ value }: { value: string }) {
  switch (value) {
  case 'name':
  case 'version':
  case 'mtime':
  case 'size':
  case 'none':
    return { ok: true as const, value };
  default:
    return { ok: false as const, message: `invalid sort mode '${value}'` };
  }
}

function parseCharset({ value }: { value: string }) {
  switch (value.toUpperCase()) {
  case 'UTF-8':
  case 'UTF8':
    return { ok: true as const, value: 'utf8' };
  case 'ASCII':
    return { ok: true as const, value: 'ascii' };
  default:
    return { ok: false as const, message: `unsupported charset '${value}'` };
  }
}

export const treeArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: 'all', effects: [{ key: 'all', value: true }], help: { summary: 'list all files', category: 'common' } },
    { kind: 'flag', short: 'd', long: 'dirs-only', effects: [{ key: 'dirsOnly', value: true }], help: { summary: 'list directories only', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'full-path', effects: [{ key: 'fullPath', value: true }], help: { summary: 'print the full path prefix for each file', category: 'common' } },
    { kind: 'flag', short: 'l', long: 'follow-links', effects: [{ key: 'followLinks', value: true }], help: { summary: 'follow symbolic links to directories', category: 'common' } },
    { kind: 'value', short: 'L', long: 'level', key: 'maxDepth', valueName: 'LEVEL', allowAttachedValue: true, parseValue: parsePositiveInteger, help: { summary: 'descend only LEVEL directories deep', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'noreport', effects: [{ key: 'noreport', value: true }], help: { summary: 'omit the file and directory report', category: 'common' } },
    { kind: 'value', short: undefined, long: 'filelimit', key: 'fileLimit', valueName: 'N', allowAttachedValue: false, parseValue: parseNonNegativeInteger, help: { summary: 'do not descend directories with more than N entries', category: 'advanced' } },
    { kind: 'value', short: 'P', long: 'pattern', key: 'includePattern', valueName: 'PATTERN', allowAttachedValue: true, parseValue: undefined, help: { summary: 'list only files that match PATTERN', category: 'common' } },
    { kind: 'value', short: 'I', long: 'ignore-pattern', key: 'excludePattern', valueName: 'PATTERN', allowAttachedValue: true, parseValue: undefined, help: { summary: 'exclude files that match PATTERN', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'ignore-case', effects: [{ key: 'ignoreCase', value: true }], help: { summary: 'ignore case when matching patterns', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'matchdirs', effects: [{ key: 'matchDirectories', value: true }], help: { summary: 'include matching directory names and their contents', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'prune', effects: [{ key: 'prune', value: true }], help: { summary: 'prune empty directories from the output', category: 'advanced' } },
    { kind: 'flag', short: 'r', long: 'reverse', effects: [{ key: 'reverse', value: true }], help: { summary: 'reverse the sort order', category: 'advanced' } },
    { kind: 'flag', short: 'U', long: undefined, effects: [{ key: 'sortMode', value: 'none' }], help: { summary: 'leave entries unsorted', category: 'advanced' } },
    { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'sortMode', value: 'version' }], help: { summary: 'sort by version', category: 'advanced' } },
    { kind: 'flag', short: 't', long: undefined, effects: [{ key: 'sortMode', value: 'mtime' }], help: { summary: 'sort by modification time', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'sort', key: 'sortMode', valueName: 'MODE', allowAttachedValue: false, parseValue: parseSortMode, help: { summary: 'sort by name, version, size, mtime, or none', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'dirsfirst', effects: [{ key: 'groupingMode', value: 'directories-first' }], help: { summary: 'list directories before files', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'filesfirst', effects: [{ key: 'groupingMode', value: 'files-first' }], help: { summary: 'list files before directories', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'charset', key: 'charset', valueName: 'CHARSET', allowAttachedValue: false, parseValue: parseCharset, help: { summary: 'use UTF-8 or ASCII line drawing characters', category: 'advanced' } },
    { kind: 'flag', short: 'i', long: undefined, effects: [{ key: 'indentMode', value: 'none' }], help: { summary: 'do not print indentation lines', category: 'advanced' } },
    { kind: 'flag', short: 'Q', long: 'quote-filenames', effects: [{ key: 'quoteNames', value: true }], help: { summary: 'quote file names in double quotes', category: 'advanced' } },
    { kind: 'flag', short: 'q', long: undefined, effects: [{ key: 'nameDisplayMode', value: 'question' }], help: { summary: 'print non-printable characters as question marks', category: 'advanced' } },
    { kind: 'flag', short: 'N', long: 'literal', effects: [{ key: 'nameDisplayMode', value: 'literal' }], help: { summary: 'print file names without escaping', category: 'advanced' } },
    { kind: 'flag', short: 'F', long: 'classify', effects: [{ key: 'classify', value: true }], help: { summary: 'append a type indicator to entries', category: 'common' } },
    { kind: 'flag', short: 'p', long: 'permissions', effects: [{ key: 'showPermissions', value: true }], help: { summary: 'print type and permission bits', category: 'advanced' } },
    { kind: 'flag', short: 'u', long: 'user', effects: [{ key: 'showUid', value: true }], help: { summary: 'print numeric user id', category: 'advanced' } },
    { kind: 'flag', short: 'g', long: 'group', effects: [{ key: 'showGid', value: true }], help: { summary: 'print numeric group id', category: 'advanced' } },
    { kind: 'flag', short: 's', long: 'size', effects: [{ key: 'showSize', value: 'bytes' }], help: { summary: 'print file sizes in bytes', category: 'advanced' } },
    { kind: 'flag', short: 'h', long: 'human-readable', effects: [{ key: 'showSize', value: 'human-1024' }], help: { summary: 'print sizes in human readable 1024-byte units', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'si', effects: [{ key: 'showSize', value: 'human-1000' }], help: { summary: 'print sizes in human readable 1000-byte units', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'du', effects: [{ key: 'showDiskUsage', value: true }, { key: 'showSize', value: 'bytes' }], help: { summary: 'print cumulative directory sizes', category: 'advanced' } },
    { kind: 'flag', short: 'D', long: 'date', effects: [{ key: 'showDate', value: true }], help: { summary: 'print modification time', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'inodes', effects: [{ key: 'showInodes', value: true }], help: { summary: 'print inode numbers', category: 'advanced' } },
    { kind: 'value', short: 'o', long: 'output', key: 'outputPath', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'send output to FILE', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'display version information and exit', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export interface ParsedTreeArgv {
  kind: 'run',
  options: TreeOptions,
  paths: string[],
}

export type TreeArgvResult =
  | ParsedTreeArgv
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error', message: string };

function optionString({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionNumber({ value }: { value: unknown }): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function parseTreeArgv({ args }: { args: string[] }): TreeArgvResult {
  const parsed = parseStandardArgv({ args, spec: treeArgvSpec });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    return { kind: 'error', message: `tree: ${diagnostic.message}` };
  }
  if (parsed.optionValues.help === true) {
    return { kind: 'help' };
  }
  if (parsed.optionValues.version === true) {
    return { kind: 'version' };
  }

  const ignoreCase = parsed.optionValues.ignoreCase === true;
  const includePatterns = parsed.occurrences.flatMap((occurrence) => {
    switch (occurrence.kind) {
    case 'value':
      return occurrence.key === 'includePattern'
        ? [compileTreePattern({ pattern: String(occurrence.value), ignoreCase })]
        : [];
    case 'flag':
    case 'special':
      return [];
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  });
  const excludePatterns = parsed.occurrences.flatMap((occurrence) => {
    switch (occurrence.kind) {
    case 'value':
      return occurrence.key === 'excludePattern'
        ? [compileTreePattern({ pattern: String(occurrence.value), ignoreCase })]
        : [];
    case 'flag':
    case 'special':
      return [];
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  });
  const sortMode = (optionString({ value: parsed.optionValues.sortMode }) ?? 'name') as TreeSortMode;
  const groupingMode = (() => {
    switch (sortMode) {
    case 'none':
      return 'mixed';
    case 'name':
    case 'version':
    case 'mtime':
    case 'size':
      return (optionString({ value: parsed.optionValues.groupingMode }) ?? 'mixed') as TreeGroupingMode;
    default: {
      const _ex: never = sortMode;
      throw new Error(`Unhandled sort mode: ${_ex}`);
    }
    }
  })();
  const charset = (optionString({ value: parsed.optionValues.charset }) ?? 'utf8') as TreeCharset;
  const prune = parsed.optionValues.dirsOnly === true ? false : parsed.optionValues.prune === true;

  return {
    kind: 'run',
    paths: parsed.positionals.length > 0 ? parsed.positionals : ['.'],
    options: {
      showAll: parsed.optionValues.all === true,
      directoriesOnly: parsed.optionValues.dirsOnly === true,
      fullPath: parsed.optionValues.fullPath === true,
      followLinks: parsed.optionValues.followLinks === true,
      maxDepth: optionNumber({ value: parsed.optionValues.maxDepth }),
      noReport: parsed.optionValues.noreport === true,
      fileLimit: optionNumber({ value: parsed.optionValues.fileLimit }),
      includePatterns,
      excludePatterns,
      ignoreCase,
      matchDirectories: parsed.optionValues.matchDirectories === true,
      prune,
      reverse: (() => {
        switch (sortMode) {
        case 'none':
          return false;
        case 'name':
        case 'version':
        case 'mtime':
        case 'size':
          return parsed.optionValues.reverse === true;
        default: {
          const _ex: never = sortMode;
          throw new Error(`Unhandled sort mode: ${_ex}`);
        }
        }
      })(),
      sortMode,
      groupingMode,
      charset,
      indentMode: parsed.optionValues.indentMode === 'none' ? 'none' : 'tree',
      quoteNames: parsed.optionValues.quoteNames === true,
      nameDisplayMode: (optionString({ value: parsed.optionValues.nameDisplayMode }) ?? 'escaped') as TreeOptions['nameDisplayMode'],
      classify: parsed.optionValues.classify === true,
      showPermissions: parsed.optionValues.showPermissions === true,
      showUid: parsed.optionValues.showUid === true,
      showGid: parsed.optionValues.showGid === true,
      showSize: (optionString({ value: parsed.optionValues.showSize }) ?? 'none') as TreeOptions['showSize'],
      showDiskUsage: parsed.optionValues.showDiskUsage === true,
      showDate: parsed.optionValues.showDate === true,
      showInodes: parsed.optionValues.showInodes === true,
      outputPath: optionString({ value: parsed.optionValues.outputPath }),
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseTreeArgv,
};
