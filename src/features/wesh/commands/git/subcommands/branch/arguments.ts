import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

type BranchDeferredSemantic = 'delete-safe' | 'delete-force';

const BRANCH_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<BranchDeferredSemantic>>({
  nonExecutableLongOptions: [
    'verbose', 'no-verbose',
    'quiet', 'no-quiet',
    'track', 'no-track',
    'set-upstream-to', 'no-set-upstream-to',
    'unset-upstream', 'no-unset-upstream',
    'color',
    'contains', 'no-contains',
    'abbrev', 'no-abbrev',
    'no-delete',
    'no-move',
    'omit-empty', 'no-omit-empty',
    'copy', 'no-copy',
    'no-list',
    'no-show-current',
    'create-reflog', 'no-create-reflog',
    'edit-description', 'no-edit-description',
    'force', 'no-force',
    'merged', 'no-merged',
    'column', 'no-column',
    'sort', 'no-sort',
    'points-at', 'no-points-at',
    'ignore-case', 'no-ignore-case',
    'recurse-submodules', 'no-recurse-submodules',
    'format', 'no-format',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'move', value: true }] },
      forms: [
        { kind: 'short', name: 'm', value: { kind: 'none' } },
        { kind: 'long', name: 'move', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'delete-safe' },
      forms: [
        { kind: 'short', name: 'd', value: { kind: 'none' } },
        { kind: 'long', name: 'delete', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'delete-force' },
      forms: [{ kind: 'short', name: 'D', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'listMode', value: 'remote' }] },
      forms: [
        { kind: 'short', name: 'r', value: { kind: 'none' } },
        { kind: 'long', name: 'remotes', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'listMode', value: 'all' }] },
      forms: [
        { kind: 'short', name: 'a', value: { kind: 'none' } },
        { kind: 'long', name: 'all', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'showCurrent', value: true }] },
      forms: [{ kind: 'long', name: 'show-current', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'listOnly', value: true }] },
      forms: [{ kind: 'long', name: 'list', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'noColor', value: true }] },
      forms: [{ kind: 'long', name: 'no-color', value: { kind: 'none' } }],
    },
  ],
});

const BRANCH_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export type BranchDeleteMode = 'none' | 'safe' | 'force';
export type BranchListMode = 'local' | 'remote' | 'all';

export interface BranchArguments {
  showCurrent: boolean;
  move: boolean;
  deleteMode: BranchDeleteMode;
  listMode: BranchListMode;
  listOnly: boolean;
  operands: string[];
}

export function parseBranchArguments({ args }: { args: readonly string[] }): BranchArguments {
  const parsed = parseStandardArgv({ args, catalog: BRANCH_ARGV_CATALOG, policy: BRANCH_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'missing_option_value':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled branch argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }

  let deleteMode: BranchDeleteMode = 'none';
  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'delete-safe':
      switch (deleteMode) {
      case 'none':
      case 'safe':
        deleteMode = 'safe';
        break;
      case 'force':
        break;
      default: {
        const _ex: never = deleteMode;
        throw new Error(`Unhandled branch delete mode: ${_ex}`);
      }
      }
      break;
    case 'delete-force':
      deleteMode = 'force';
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled branch deferred semantic: ${_ex}`);
    }
    }
  }

  const listModeValue = parsed.optionValues.listMode;
  const listMode: BranchListMode = listModeValue === 'remote' || listModeValue === 'all'
    ? listModeValue
    : 'local';
  return {
    showCurrent: parsed.optionValues.showCurrent === true,
    move: parsed.optionValues.move === true,
    deleteMode,
    listMode,
    listOnly: parsed.optionValues.listOnly === true,
    operands: [...parsed.positionals],
  };
}

export const TEST_ONLY = {
};
