import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const mvArgvSpec: StandardArgvParserSpec = {
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

export const mvCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mv',
    description: 'Move or rename files',
    usage: 'mv source destination',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: mvArgvSpec,
    });

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'mv',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    if (context.args.length < 2) {
      await writeCommandUsageError({
        context,
        command: 'mv',
        message: 'mv: missing file operand',
        argvSpec: mvArgvSpec,
      });
      return { exitCode: 1 };
    }

    const src = context.args[0]!;
    const dest = context.args[1]!;

    try {
      const fullSrc = src.startsWith('/') ? src : `${context.cwd}/${src}`;
      let fullDest = dest.startsWith('/') ? dest : `${context.cwd}/${dest}`;

      try {
        const destStat = await context.kernel.stat({ path: fullDest });
        switch (destStat.type) {
        case 'directory': {
          const srcName = src.split('/').filter(Boolean).pop()!;
          fullDest = `${fullDest}/${srcName}`;
          break;
        }
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          break;
        default: {
          const _ex: never = destStat.type;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      } catch {
        // Destination does not exist, which is fine for rename
      }

      await context.kernel.rename({ oldPath: fullSrc, newPath: fullDest });
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `mv: ${src}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
