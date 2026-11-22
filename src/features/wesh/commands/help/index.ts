import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const helpOptions = [
  {
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const helpArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: helpOptions, nonExecutableLongOptions: [] });
const helpArgvHelp = defineArgvHelpPresentation({ catalog: helpArgvCatalog, rows: helpOptions });

export const helpCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: helpArgvCatalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'none' },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'help',
        message: `help: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: helpArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'help',
        optionLines: formatArgvOptionHelp({ presentation: helpArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const target = parsed.positionals[0];

    if (target) {
      const meta = context.getWeshCommandMeta({ name: target });
      if (meta === undefined) {
        await text.error({ text: `help: no help topics match '${target}'\n` });
        return { exitCode: 1 };
      }

      await writeCommandHelp({
        context,
        command: target,
        optionLines: [],
      });
      return { exitCode: 0 };
    }

    await text.print({ text: 'Available commands:\n' });
    const names = context.getCommandNames().sort();
    for (const name of names) {
      const meta = context.getWeshCommandMeta({ name });
      const paddedName = name.padEnd(10);
      await text.print({ text: `  ${paddedName} - ${meta?.description || ''}\n` });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
