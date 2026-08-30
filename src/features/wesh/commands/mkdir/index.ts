import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { getCoreUmaskOrDefault } from '@/features/wesh/commands/_shared/core-capability';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';

const mkdirParentsOption = {
  semantic: { kind: 'effects', effects: [{ key: 'parents', value: true }] },
  forms: [
    { kind: 'short', name: 'p', value: { kind: 'none' } },
    { kind: 'long', name: 'parents', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const mkdirVerboseOption = {
  semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
  forms: [
    { kind: 'short', name: 'v', value: { kind: 'none' } },
    { kind: 'long', name: 'verbose', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const mkdirModeOption = {
  semantic: { kind: 'required-value', key: 'mode', parse: undefined },
  forms: [
    { kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'MODE' } },
    { kind: 'long', name: 'mode', value: { kind: 'required', missingValueName: 'MODE' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const mkdirHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const mkdirArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['context', 'version'],
  definitions: [mkdirParentsOption, mkdirVerboseOption, mkdirModeOption, mkdirHelpOption],
});
const mkdirArgvHelp = defineArgvHelpPresentation({
  catalog: mkdirArgvCatalog,
  rows: [
    { forms: mkdirParentsOption.forms, summary: 'make parent directories as needed' },
    { forms: mkdirVerboseOption.forms, summary: 'print a message for each created directory', category: 'common' },
    { forms: mkdirModeOption.forms, summary: 'set file permission bits to MODE', valueName: 'MODE', category: 'common' },
    { forms: mkdirHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const mkdirArgvPolicy: StandardArgvPolicy = {
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

async function createDirectoriesLexically({
  context,
  operand,
  mode,
  verbose,
}: {
  context: WeshCommandContext,
  operand: string,
  mode: number,
  verbose: boolean,
}): Promise<void> {
  if (operand.length === 0) {
    throw new Error('No such file or directory');
  }

  const components = [...operand.matchAll(/[^/]+/gu)].map((match) => ({
    segment: match[0],
    prefix: operand.slice(0, (match.index ?? 0) + match[0].length),
  }));
  const finalSegmentIndex = components.length - 1;
  const finalSegment = components[finalSegmentIndex]?.segment;
  const finalOperandSegmentIndex = finalSegment === '.' || finalSegment === '..'
    ? undefined
    : finalSegmentIndex;

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined) continue;
    const { segment, prefix: lexicalPath } = component;
    if (segment === '.' || segment === '..') {
      continue;
    }
    const fullPath = lexicalPath.startsWith('/')
      ? lexicalPath
      : context.cwd === '/' ? `/${lexicalPath}` : `${context.cwd}/${lexicalPath}`;
    if (await pathExists({ context, path: fullPath })) {
      const stat = await context.files.stat({ path: fullPath });
      switch (stat.type) {
      case 'directory':
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        throw new Error('File exists');
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled existing path type: ${_ex}`);
      }
      }
      continue;
    }

    await context.files.mkdir({ path: fullPath, mode, recursive: false });
    if (verbose) {
      const displayPath = index === finalOperandSegmentIndex ? operand : lexicalPath;
      await context.text().print({ text: `mkdir: created directory '${displayPath}'\n` });
    }
  }
}

export const mkdirCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkdir',
    description: 'Create directories',
    usage: 'mkdir [OPTION]... DIRECTORY...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: mkdirArgvCatalog,
        policy: mkdirArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: mkdirArgvCatalog,
      policy: mkdirArgvPolicy,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'mkdir',
        message: `mkdir: ${parsed.diagnostics[0]!.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: mkdirArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mkdir',
        optionLines: formatArgvOptionHelp({ presentation: mkdirArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const requestedMode = parsed.optionValues.mode;
    const umask = getCoreUmaskOrDefault({ context });
    const symbolicModeOmitsWho = typeof requestedMode === 'string'
      && !/^[0-7]{1,4}$/u.test(requestedMode)
      && requestedMode.split(',').some(clause => /^[+=-]/u.test(clause));
    const parsedMode = typeof requestedMode === 'string'
      ? parseFilePermissionMode({
        value: requestedMode,
        initialMode: symbolicModeOmitsWho ? 0o777 & ~umask : 0o777,
        umask,
        allowSpecialBits: true,
      })
      : { ok: true as const, mode: 0o777 & ~umask };
    if (!parsedMode.ok) {
      await context.text().error({
        text: parsedMode.specialBits
          ? 'mkdir: mode must specify only supported permission bits\n'
          : `mkdir: invalid mode '${String(requestedMode)}'\n`,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'mkdir',
        message: 'mkdir: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: mkdirArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const recursive = parsed.optionValues.parents === true;
    const text = context.text();
    const verbose = parsed.optionValues.verbose === true;
    let exitCode = 0;

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : (context.cwd === '/' ? `/${p}` : `${context.cwd}/${p}`);
        if (!recursive && await pathExists({ context, path: fullPath })) {
          await text.error({ text: `mkdir: cannot create directory '${p}': File exists\n` });
          exitCode = 1;
          continue;
        }
        if (recursive) {
          await createDirectoriesLexically({
            context,
            operand: p,
            mode: parsedMode.mode,
            verbose,
          });
        } else {
          await context.files.mkdir({ path: fullPath, mode: parsedMode.mode, recursive: false });
          if (verbose) {
            await text.print({ text: `mkdir: created directory '${p}'\n` });
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `mkdir: cannot create directory '${p}': ${message}\n` });
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
