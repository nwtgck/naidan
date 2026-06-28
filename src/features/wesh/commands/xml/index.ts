import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { runXmlSelect } from '@/features/wesh/commands/xml/select';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

export const xmlCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'xml',
    description: 'XMLStarlet-like XML toolkit built on browser DOM/XPath APIs',
    usage: 'xml <command> [options] [args]',
  },
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
