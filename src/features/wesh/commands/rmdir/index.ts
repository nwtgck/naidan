import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stripTrailingSlashes } from '@/features/wesh/commands/_shared/path';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const rmdirArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'p',
      long: 'parents',
      effects: [{ key: 'parents', value: true }],
      help: { summary: 'remove DIRECTORY and its empty ancestors', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'v',
      long: 'verbose',
      effects: [{ key: 'verbose', value: true }],
      help: { summary: 'output a diagnostic for every directory processed', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'ignore-fail-on-non-empty',
      effects: [{ key: 'ignoreNonEmpty', value: true }],
      help: { summary: 'ignore failures caused by non-empty directories', category: 'advanced' },
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

export const rmdirCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rmdir',
    description: 'Remove empty directories',
    usage: 'rmdir directory...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: rmdirArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: rmdirArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: `rmdir: ${diagnostic.message}`,
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rmdir',
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: 'rmdir: missing operand',
        argvSpec: rmdirArgvSpec,
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
