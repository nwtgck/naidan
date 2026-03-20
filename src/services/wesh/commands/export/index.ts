import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const exportArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'print', value: true }], help: { summary: 'show exported names and values in a reusable format', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const exportCmdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'export',
    description: 'Set environment variables',
    usage: 'export [-p] name=value...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: exportArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'export',
        message: `export: ${diagnostic.message}`,
        argvSpec: exportArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'export',
        argvSpec: exportArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (parsed.optionValues.print === true) {
      for (const [key, val] of context.env) {
        await text.print({ text: `export ${key}='${val}'\n` });
      }
      return { exitCode: 0 };
    }

    for (const p of parsed.positionals) {
      const idx = p.indexOf('=');
      if (idx !== -1) {
        const key = p.slice(0, idx);
        const value = p.slice(idx + 1);
        context.setEnv({ key, value });
      }
    }

    return { exitCode: 0 };
  },
};
