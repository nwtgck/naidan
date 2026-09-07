import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { stripTrailingSlashes } from '@/features/wesh/commands/_shared/path';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const rmdirParentsShortForm = { kind: 'short', name: 'p', value: { kind: 'none' } } as const;
// GNU rmdir accepts --path as a hidden alias of --parents. Keep it executable in
// the same definition so unique-prefix resolution collapses --p / --pa as one
// semantic option rather than reporting a false ambiguity. It stays out of help.
const rmdirParentsPathAliasForm = { kind: 'long', name: 'path', value: { kind: 'none' } } as const;
const rmdirParentsLongForm = { kind: 'long', name: 'parents', value: { kind: 'none' } } as const;
const rmdirParentsOption = {
  semantic: { kind: 'effects', effects: [{ key: 'parents', value: true }] },
  forms: [rmdirParentsShortForm, rmdirParentsPathAliasForm, rmdirParentsLongForm],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const rmdirVerboseOption = {
  semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
  forms: [
    { kind: 'short', name: 'v', value: { kind: 'none' } },
    { kind: 'long', name: 'verbose', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const rmdirIgnoreNonEmptyOption = {
  semantic: { kind: 'effects', effects: [{ key: 'ignoreNonEmpty', value: true }] },
  forms: [{ kind: 'long', name: 'ignore-fail-on-non-empty', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const rmdirHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const rmdirArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  // GNU rmdir also has --version. Wesh intentionally does not implement it, but
  // it must still block prefixes such as --v/--ver from resolving to --verbose.
  nonExecutableLongOptions: ['version'],
  definitions: [rmdirParentsOption, rmdirVerboseOption, rmdirIgnoreNonEmptyOption, rmdirHelpOption],
});
const rmdirArgvHelp = defineArgvHelpPresentation({
  catalog: rmdirArgvCatalog,
  rows: [
    { forms: [rmdirParentsShortForm, rmdirParentsLongForm], summary: 'remove DIRECTORY and its empty ancestors', category: 'common' },
    { forms: rmdirVerboseOption.forms, summary: 'output a diagnostic for every directory processed', category: 'common' },
    { forms: rmdirIgnoreNonEmptyOption.forms, summary: 'ignore failures caused by non-empty directories', category: 'advanced' },
    { forms: rmdirHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const rmdirArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const rmdirCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: rmdirArgvCatalog,
        policy: rmdirArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: rmdirArgvCatalog,
      policy: rmdirArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: `rmdir: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: rmdirArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rmdir',
        optionLines: formatArgvOptionHelp({ presentation: rmdirArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: 'rmdir: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: rmdirArgvHelp }),
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    const removeParents = parsed.optionValues.parents === true;
    const ignoreNonEmpty = parsed.optionValues.ignoreNonEmpty === true;
    const verbose = parsed.optionValues.verbose === true;

    // `rmdir -p` walks the lexical parents named by the operand, not the
    // resolved parents above the current working directory. Keeping this
    // distinction prevents `rmdir -p one/two` from attempting to remove cwd,
    // while preserving meaningful `.` and `..` components for the filesystem
    // to reject in the same place as a native rmdir implementation.
    const parentOperand = ({ path }: { path: string }): string | undefined => {
      const withoutTrailingSlashes = stripTrailingSlashes({ path });
      const separatorIndex = withoutTrailingSlashes.lastIndexOf('/');
      if (separatorIndex < 0) {
        return undefined;
      }

      const prefix = stripTrailingSlashes({
        path: withoutTrailingSlashes.slice(0, separatorIndex),
      });
      if (prefix.length > 0) {
        return prefix;
      }
      return withoutTrailingSlashes.startsWith('/') ? '/' : undefined;
    };

    const filesystemPath = ({ operand }: { operand: string }): string => {
      const withoutTrailingSlashes = stripTrailingSlashes({ path: operand });
      if (withoutTrailingSlashes.startsWith('/')) {
        return withoutTrailingSlashes;
      }
      return context.cwd === '/'
        ? `/${withoutTrailingSlashes}`
        : `${context.cwd}/${withoutTrailingSlashes}`;
    };

    const removeEmptyDirectory = async ({
      path,
    }: {
      path: string;
    }): Promise<'removed' | 'ignored-non-empty'> => {
      const finalComponent = stripTrailingSlashes({ path }).split('/').at(-1);
      if (finalComponent === '.') {
        throw new Error('Invalid argument');
      }
      if (finalComponent === '..') {
        if (ignoreNonEmpty) {
          return 'ignored-non-empty';
        }
        throw new Error('Directory not empty');
      }

      for await (const _entry of context.files.readDir({ path })) {
        if (ignoreNonEmpty) {
          return 'ignored-non-empty';
        }
        throw new Error('Directory not empty');
      }
      await context.files.rmdir({ path });
      return 'removed';
    };

    for (const p of parsed.positionals) {
      let failedOperand = p;
      try {
        let operand: string | undefined = p;
        while (operand !== undefined) {
          failedOperand = operand;
          if (verbose) {
            await text.print({ text: `rmdir: removing directory, '${operand}'\n` });
          }
          if (operand.length === 0) {
            throw new Error('No such file or directory');
          }
          const result = await removeEmptyDirectory({
            path: filesystemPath({ operand }),
          });
          switch (result) {
          case 'ignored-non-empty':
            operand = undefined;
            break;
          case 'removed':
            operand = removeParents ? parentOperand({ path: operand }) : undefined;
            break;
          default: {
            const _ex: never = result;
            throw new Error(`Unhandled removal result: ${_ex}`);
          }
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `rmdir: failed to remove '${failedOperand}': ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
