import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { getCoreUmaskOrDefault } from '@/features/wesh/commands/_shared/core-capability';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

const mkfifoArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'm',
      long: 'mode',
      key: 'mode',
      valueName: 'MODE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'set file permission bits to MODE', valueName: 'MODE', category: 'common' },
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

async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<boolean> {
  try {
    await context.files.lstat({ path });
    return true;
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) return false;
    throw error;
  }
}

export const mkfifoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkfifo',
    description: 'Make FIFOs (named pipes)',
    usage: 'mkfifo [OPTION]... NAME...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: mkfifoArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: mkfifoArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'mkfifo',
        message: `mkfifo: ${diagnostic.message}`,
        argvSpec: mkfifoArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mkfifo',
        argvSpec: mkfifoArgvSpec,
      });
      return { exitCode: 0 };
    }

    const requestedMode = parsed.optionValues.mode;
    const umask = getCoreUmaskOrDefault({ context });
    const parsedMode = typeof requestedMode === 'string'
      ? parseFilePermissionMode({ value: requestedMode, initialMode: 0o666, umask, allowSpecialBits: false })
      : { ok: true as const, mode: 0o666 & ~umask };
    if (!parsedMode.ok) {
      await context.text().error({
        text: parsedMode.specialBits
          ? 'mkfifo: mode must specify only file permission bits\n'
          : 'mkfifo: invalid mode\n',
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'mkfifo',
        message: 'mkfifo: missing operand',
        argvSpec: mkfifoArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    let exitCode = 0;

    for (const path of parsed.positionals) {
      try {
        const fullPath = path.startsWith('/')
          ? path
          : context.cwd === '/'
            ? `/${path}`
            : `${context.cwd}/${path}`;
        const exists = await pathExists({ context, path: fullPath });
        if (exists || path.endsWith('/')) {
          const reason = exists ? 'File exists' : 'No such file or directory';
          await text.error({ text: `mkfifo: cannot create fifo '${path}': ${reason}\n` });
          exitCode = 1;
          continue;
        }
        await context.files.mknod({ path: fullPath, type: 'fifo', mode: parsedMode.mode });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `mkfifo: cannot create fifo '${path}': ${message}\n` });
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
