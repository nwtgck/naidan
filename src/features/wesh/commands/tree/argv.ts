import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  parseStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { compileTreePattern } from './pattern';
import type { TreeCharset, TreeGroupingMode, TreeOptions, TreeSortMode } from './types';

type TreePatternOption = 'includePattern' | 'excludePattern';

function parsePositiveInteger({ rawValue: value }: { rawValue: string }) {
  if (!/^\d+$/.test(value)) {
    return { kind: 'invalid' as const, message: `invalid integer '${value}'` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { kind: 'invalid' as const, message: `invalid level '${value}'` };
  }
  return { kind: 'parsed' as const, value: parsed };
}

function parseNonNegativeInteger({ rawValue: value }: { rawValue: string }) {
  if (!/^\d+$/.test(value)) {
    return { kind: 'invalid' as const, message: `invalid integer '${value}'` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { kind: 'invalid' as const, message: `invalid count '${value}'` };
  }
  return { kind: 'parsed' as const, value: parsed };
}

function parseSortMode({ rawValue: value }: { rawValue: string }) {
  switch (value) {
  case 'name':
  case 'version':
  case 'mtime':
  case 'size':
  case 'none':
    return { kind: 'parsed' as const, value };
  default:
    return { kind: 'invalid' as const, message: `invalid sort mode '${value}'` };
  }
}

function parseCharset({ rawValue: value }: { rawValue: string }) {
  switch (value.toUpperCase()) {
  case 'UTF-8':
  case 'UTF8':
    return { kind: 'parsed' as const, value: 'utf8' };
  case 'ASCII':
    return { kind: 'parsed' as const, value: 'ascii' };
  default:
    return { kind: 'invalid' as const, message: `unsupported charset '${value}'` };
  }
}

const treeOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'none' } },
      { kind: 'long', name: 'all', value: { kind: 'none' } },
    ],
    summary: 'list all files',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'dirsOnly', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'dirs-only', value: { kind: 'none' } },
    ],
    summary: 'list directories only',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'fullPath', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'full-path', value: { kind: 'none' } },
    ],
    summary: 'print the full path prefix for each file',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'followLinks', value: true }] },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'none' } },
      { kind: 'long', name: 'follow-links', value: { kind: 'none' } },
    ],
    summary: 'follow symbolic links to directories',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'maxDepth', parse: parsePositiveInteger },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'required-attached-or-following', missingValueName: 'LEVEL' } },
      { kind: 'long', name: 'level', value: { kind: 'required', missingValueName: 'LEVEL' } },
    ],
    summary: 'descend only LEVEL directories deep',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noreport', value: true }] },
    forms: [{ kind: 'long', name: 'noreport', value: { kind: 'none' } }],
    summary: 'omit the file and directory report',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'fileLimit', parse: parseNonNegativeInteger },
    forms: [{ kind: 'long', name: 'filelimit', value: { kind: 'required', missingValueName: 'N' } }],
    summary: 'do not descend directories with more than N entries',
    category: 'advanced',
  },
  {
    semantic: { kind: 'deferred', tag: 'includePattern' },
    forms: [
      { kind: 'short', name: 'P', value: { kind: 'required-attached-or-following', missingValueName: 'PATTERN' } },
      { kind: 'long', name: 'pattern', value: { kind: 'required', missingValueName: 'PATTERN' } },
    ],
    summary: 'list only files that match PATTERN',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'excludePattern' },
    forms: [
      { kind: 'short', name: 'I', value: { kind: 'required-attached-or-following', missingValueName: 'PATTERN' } },
      { kind: 'long', name: 'ignore-pattern', value: { kind: 'required', missingValueName: 'PATTERN' } },
    ],
    summary: 'exclude files that match PATTERN',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreCase', value: true }] },
    forms: [{ kind: 'long', name: 'ignore-case', value: { kind: 'none' } }],
    summary: 'ignore case when matching patterns',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'matchDirectories', value: true }] },
    forms: [{ kind: 'long', name: 'matchdirs', value: { kind: 'none' } }],
    summary: 'include matching directory names and their contents',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'prune', value: true }] },
    forms: [{ kind: 'long', name: 'prune', value: { kind: 'none' } }],
    summary: 'prune empty directories from the output',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'reverse', value: true }] },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'reverse', value: { kind: 'none' } },
    ],
    summary: 'reverse the sort order',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'sortMode', value: 'none' }] },
    forms: [{ kind: 'short', name: 'U', value: { kind: 'none' } }],
    summary: 'leave entries unsorted',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'sortMode', value: 'version' }] },
    forms: [{ kind: 'short', name: 'v', value: { kind: 'none' } }],
    summary: 'sort by version',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'sortMode', value: 'mtime' }] },
    forms: [{ kind: 'short', name: 't', value: { kind: 'none' } }],
    summary: 'sort by modification time',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'sortMode', parse: parseSortMode },
    forms: [{ kind: 'long', name: 'sort', value: { kind: 'required', missingValueName: 'MODE' } }],
    summary: 'sort by name, version, size, mtime, or none',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'groupingMode', value: 'directories-first' }] },
    forms: [{ kind: 'long', name: 'dirsfirst', value: { kind: 'none' } }],
    summary: 'list directories before files',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'groupingMode', value: 'files-first' }] },
    forms: [{ kind: 'long', name: 'filesfirst', value: { kind: 'none' } }],
    summary: 'list files before directories',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'charset', parse: parseCharset },
    forms: [{ kind: 'long', name: 'charset', value: { kind: 'required', missingValueName: 'CHARSET' } }],
    summary: 'use UTF-8 or ASCII line drawing characters',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'indentMode', value: 'none' }] },
    forms: [{ kind: 'short', name: 'i', value: { kind: 'none' } }],
    summary: 'do not print indentation lines',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quoteNames', value: true }] },
    forms: [
      { kind: 'short', name: 'Q', value: { kind: 'none' } },
      { kind: 'long', name: 'quote-filenames', value: { kind: 'none' } },
    ],
    summary: 'quote file names in double quotes',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'nameDisplayMode', value: 'question' }] },
    forms: [{ kind: 'short', name: 'q', value: { kind: 'none' } }],
    summary: 'print non-printable characters as question marks',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'nameDisplayMode', value: 'literal' }] },
    forms: [
      { kind: 'short', name: 'N', value: { kind: 'none' } },
      { kind: 'long', name: 'literal', value: { kind: 'none' } },
    ],
    summary: 'print file names without escaping',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'classify', value: true }] },
    forms: [
      { kind: 'short', name: 'F', value: { kind: 'none' } },
      { kind: 'long', name: 'classify', value: { kind: 'none' } },
    ],
    summary: 'append a type indicator to entries',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showPermissions', value: true }] },
    forms: [
      { kind: 'short', name: 'p', value: { kind: 'none' } },
      { kind: 'long', name: 'permissions', value: { kind: 'none' } },
    ],
    summary: 'print type and permission bits',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showUid', value: true }] },
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'long', name: 'user', value: { kind: 'none' } },
    ],
    summary: 'print numeric user id',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showGid', value: true }] },
    forms: [
      { kind: 'short', name: 'g', value: { kind: 'none' } },
      { kind: 'long', name: 'group', value: { kind: 'none' } },
    ],
    summary: 'print numeric group id',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showSize', value: 'bytes' }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'size', value: { kind: 'none' } },
    ],
    summary: 'print file sizes in bytes',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showSize', value: 'human-1024' }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'human-readable', value: { kind: 'none' } },
    ],
    summary: 'print sizes in human readable 1024-byte units',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showSize', value: 'human-1000' }] },
    forms: [{ kind: 'long', name: 'si', value: { kind: 'none' } }],
    summary: 'print sizes in human readable 1000-byte units',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showDiskUsage', value: true }, { key: 'showSize', value: 'bytes' }] },
    forms: [{ kind: 'long', name: 'du', value: { kind: 'none' } }],
    summary: 'print cumulative directory sizes',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showDate', value: true }] },
    forms: [
      { kind: 'short', name: 'D', value: { kind: 'none' } },
      { kind: 'long', name: 'date', value: { kind: 'none' } },
    ],
    summary: 'print modification time',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showInodes', value: true }] },
    forms: [{ kind: 'long', name: 'inodes', value: { kind: 'none' } }],
    summary: 'print inode numbers',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'outputPath', parse: undefined },
    forms: [
      { kind: 'short', name: 'o', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'output', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'send output to FILE',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'version', value: true }] },
    forms: [{ kind: 'long', name: 'version', value: { kind: 'none' } }],
    summary: 'display version information and exit',
    category: 'advanced',
  },
] as const;

const treeArgvCatalog = defineArgvCatalog<StandardArgvAction<TreePatternOption>>({
  definitions: treeOptions,
  nonExecutableLongOptions: [],
});
export const treeArgvHelp = defineArgvHelpPresentation({ catalog: treeArgvCatalog, rows: treeOptions });
const treeArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export interface ParsedTreeArgv {
  kind: 'run',
  options: TreeOptions,
  paths: readonly string[],
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
  const parsed = parseStandardArgv({ args, catalog: treeArgvCatalog, policy: treeArgvPolicy });
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
  const includePatterns: TreeOptions['includePatterns'] = [];
  const excludePatterns: TreeOptions['excludePatterns'] = [];
  for (const { semantic, value } of parsed.deferred) {
    switch (value.kind) {
    case 'none':
      throw new Error('Missing tree pattern');
    case 'inline':
    case 'next-argv':
      break;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled tree pattern value: ${JSON.stringify(_ex)}`);
    }
    }
    const pattern = compileTreePattern({ pattern: value.rawValue, ignoreCase });
    switch (semantic.tag) {
    case 'includePattern':
      includePatterns.push(pattern);
      break;
    case 'excludePattern':
      excludePatterns.push(pattern);
      break;
    default: {
      const _ex: never = semantic.tag;
      throw new Error(`Unhandled tree pattern option: ${_ex}`);
    }
    }
  }
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
