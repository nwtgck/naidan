import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshShellBuiltinFunction } from '@/features/wesh/types';
import { formatResolvedCommand, resolveCommand, shellIntrinsicNames } from '@/features/wesh/command-resolution';

const WESH_STANDARD_COMMAND_PATH = '/bin:/usr/bin';

const commandOptions = [
  {
    forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'standardPath', value: true }] },
    summary: 'use a standard utility search path',
  },
  {
    forms: [{ kind: 'short', name: 'v', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
    summary: 'print the resolved command name and stop',
  },
  {
    forms: [{ kind: 'short', name: 'V', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'describe', value: true }] },
    summary: 'print a description of the resolved command and stop',
  },
  {
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const commandArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: commandOptions, nonExecutableLongOptions: [] });
const commandArgvHelp = defineArgvHelpPresentation({ catalog: commandArgvCatalog, rows: commandOptions });

export const commandCommandImplementation = {
  fn: async ({ context, shell }) => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: commandArgvCatalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'none' },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'command',
        message: `command: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: commandArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'command',
        optionLines: formatArgvOptionHelp({ presentation: commandArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const searchPathOverride = parsed.optionValues.standardPath === true ? WESH_STANDARD_COMMAND_PATH : undefined;
    const searchPath = searchPathOverride ?? shell.getSearchPath() ?? '';
    const searchPathEntries = searchPath.split(':');

    if (parsed.positionals.length === 0) {
      return { exitCode: 0 };
    }

    if (parsed.optionValues.verbose === true || parsed.optionValues.describe === true) {
      const text = context.text();
      let foundAny = false;
      const formatMode = parsed.optionValues.describe === true ? 'command-V' : 'command-v';

      for (const name of parsed.positionals) {
        if (name === 'builtin' || shellIntrinsicNames.has(name)) {
          const formattedControlBuiltin = (() => {
            switch (formatMode) {
            case 'command-v':
              return name;
            case 'command-V':
              return `${name} is a shell builtin`;
            default: {
              const _ex: never = formatMode;
              throw new Error(`Unhandled command format mode: ${_ex}`);
            }
            }
          })();
          await text.print({ text: `${formattedControlBuiltin}\n` });
          foundAny = true;
          continue;
        }
        if (shell.hasFunction({ name })) {
          const formattedFunction = (() => {
            switch (formatMode) {
            case 'command-v':
              return name;
            case 'command-V':
              return `${name} is a function`;
            default: {
              const _ex: never = formatMode;
              throw new Error(`Unhandled command format mode: ${_ex}`);
            }
            }
          })();
          await text.print({ text: `${formattedFunction}\n` });
          foundAny = true;
          continue;
        }

        const resolved = await resolveCommand({
          context,
          name,
          searchPathEntries,
        });
        const formatted = formatResolvedCommand({
          resolved,
          mode: formatMode,
        });

        if (formatted === undefined) {
          switch (formatMode) {
          case 'command-v':
            break;
          case 'command-V':
            await text.error({ text: `command: ${name}: not found\n` });
            break;
          default: {
            const _ex: never = formatMode;
            throw new Error(`Unhandled command format mode: ${_ex}`);
          }
          }
          continue;
        }

        await text.print({ text: `${formatted}\n` });
        foundAny = true;
      }

      return { exitCode: foundAny ? 0 : 1 };
    }

    const cmdName = parsed.positionals[0]!;
    if (cmdName === 'builtin' || shellIntrinsicNames.has(cmdName)) {
      return shell.evaluateCommand({ command: cmdName, args: parsed.positionals.slice(1), searchPathOverride: searchPath, functionLookup: 'bypass' });
    }
    const resolved = await resolveCommand({
      context,
      name: cmdName,
      searchPathEntries,
    });

    switch (resolved.kind) {
    case 'builtin':
    case 'file':
      return shell.evaluateCommand({ command: cmdName, args: parsed.positionals.slice(1), searchPathOverride: searchPath, functionLookup: 'bypass' });
    case 'not_found':
      await context.text().error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 127 };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
    }
    }
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'evaluateCommand' | 'getSearchPath' | 'hasFunction'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
