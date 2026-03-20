import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const mkfifoArgvSpec: StandardArgvParserSpec = {
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

export const mkfifoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkfifo',
    description: 'Make FIFOs (named pipes)',
    usage: 'mkfifo [path...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: mkfifoArgvSpec,
    });

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mkfifo',
        argvSpec: mkfifoArgvSpec,
      });
      return { exitCode: 0 };
    }

    const paths = context.args;
    const text = context.text();

    if (paths.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'mkfifo',
        message: 'mkfifo: missing operand',
        argvSpec: mkfifoArgvSpec,
      });
      return { exitCode: 1 };
    }

    for (const p of paths) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        // vfs.mknod is now in Kernel.
        await context.kernel.mknod({ path: fullPath, type: 'fifo', mode: 0o644 });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `mkfifo: cannot create fifo '${p}': ${message}\n` });
        return { exitCode: 1 };
      }
    }

    return { exitCode: 0 };
  },
};
