import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { formatResolvedCommand, resolveCommands } from '@/features/wesh/command-resolution';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

const whichArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: undefined, effects: [{ key: 'all', value: true }], help: { summary: 'print all matching command locations', category: 'common' } },
    { kind: 'flag', short: 's', long: undefined, effects: [{ key: 'silent', value: true }], help: { summary: 'return status only without printing locations', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const whichCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'which',
    description: 'Locate a command',
    usage: 'which [-as] command...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({
        args: context.args,
        spec: whichArgvSpec,
      }),
      spec: whichArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'which',
        message: `which: ${diagnostic.message}`,
        argvSpec: whichArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'which',
        argvSpec: whichArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      return { exitCode: 1 };
    }

    const text = context.text();
    const includeAll = parsed.optionValues.all === true;
    const silent = parsed.optionValues.silent === true;
    let foundAll = true;

    for (const name of parsed.positionals) {
      const matches = (await resolveCommands({
        context,
        name,
      })).filter(resolved => resolved.kind !== 'file' || resolved.executable);
      if (matches.length === 0) {
        foundAll = false;
        continue;
      }

      if (silent) {
        continue;
      }

      const selectedMatches = includeAll ? matches : matches.slice(0, 1);
      for (const resolved of selectedMatches) {
        const formatted = formatResolvedCommand({
          resolved,
          mode: 'which',
        });
        if (formatted !== undefined) {
          await text.print({ text: `${formatted}\n` });
        }
      }
    }

    return { exitCode: foundAll ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
