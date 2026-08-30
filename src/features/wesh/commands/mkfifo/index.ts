import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { getCoreUmaskOrDefault } from '@/features/wesh/commands/_shared/core-capability';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

const mkfifoModeOption = {
  semantic: { kind: 'required-value', key: 'mode', parse: undefined },
  forms: [
    { kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'MODE' } },
    { kind: 'long', name: 'mode', value: { kind: 'required', missingValueName: 'MODE' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const mkfifoHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const mkfifoArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['context', 'version'],
  definitions: [mkfifoModeOption, mkfifoHelpOption],
});
const mkfifoArgvHelp = defineArgvHelpPresentation({
  catalog: mkfifoArgvCatalog,
  rows: [
    { forms: mkfifoModeOption.forms, summary: 'set file permission bits to MODE', valueName: 'MODE', category: 'common' },
    { forms: mkfifoHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const mkfifoArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
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
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: mkfifoArgvCatalog,
        policy: mkfifoArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: mkfifoArgvCatalog,
      policy: mkfifoArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'mkfifo',
        message: `mkfifo: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: mkfifoArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mkfifo',
        optionLines: formatArgvOptionHelp({ presentation: mkfifoArgvHelp }),
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
        usageSummary: formatArgvUsageSummary({ presentation: mkfifoArgvHelp }),
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
