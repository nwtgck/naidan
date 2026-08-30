import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { runXmlSelect } from '@/features/wesh/commands/xml/select';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

export const xmlCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const [subcommand, ...rest] = context.args;

    switch (subcommand) {
    case undefined:
    case '--help':
      await writeCommandHelp({
        context,
        command: 'xml',
      });
      await context.text().print({
        text: `\
commands:
  sel      select data from XML using XPath
`,
      });
      return { exitCode: 0 };
    case 'sel':
    case 'select':
      return runXmlSelect({
        context,
        args: rest,
      });
    default:
      await writeCommandUsageError({
        context,
        command: 'xml',
        message: `xml: unknown command '${subcommand}'`,
      });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
