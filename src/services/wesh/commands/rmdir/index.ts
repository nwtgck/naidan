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

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: `rmdir: ${diagnostic.message}`,
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rmdir',
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'rmdir',
        message: 'rmdir: missing operand',
        argvSpec: rmdirArgvSpec,
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : (context.cwd === '/' ? `/${p}` : `${context.cwd}/${p}`);
        const entries = await context.files.readDir({ path: fullPath });
        if (entries.length > 0) {
          throw new Error('Directory not empty');
        }
        await context.files.rmdir({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `rmdir: failed to remove '${p}': ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
