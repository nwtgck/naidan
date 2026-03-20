import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const rmdirArgvSpec: StandardArgvParserSpec = {
  options: [
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
      args: context.args,
      spec: rmdirArgvSpec,
    });

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rmdir',
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (context.args.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: 'rmdir: missing operand',
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 1 };
    }

    for (const p of context.args) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const entries = await context.files.readDir({ path: fullPath });
        if (entries.length > 0) {
          throw new Error('Directory not empty');
        }
        await context.files.rmdir({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `rmdir: failed to remove '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
