import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshTrapDisposition,
} from '@/services/wesh/types';

const trapArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'p',
      long: undefined,
      effects: [{ key: 'print', value: true }],
      help: { summary: 'print traps', category: 'common' },
    },
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

function shellQuote({
  text,
}: {
  text: string;
}): string {
  return `'${text.replaceAll('\'', `'\\''`)}'`;
}

export const trapCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'trap',
    description: 'Set shell trap handlers',
    usage: 'trap [-p] [action condition ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: trapArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'trap',
        message: `trap: ${diagnostic.message}`,
        argvSpec: trapArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'trap',
        argvSpec: trapArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.print === true || parsed.positionals.length === 0) {
      const { print } = context.text();
      for (const [condition, disposition] of context.getTraps()) {
        switch (disposition.kind) {
        case 'ignore':
          await print({
            text: `trap -- '' ${condition}\n`,
          });
          break;
        case 'run':
          await print({
            text: `trap -- ${shellQuote({ text: disposition.action })} ${condition}\n`,
          });
          break;
        default: {
          const _ex: never = disposition;
          throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return { exitCode: 0 };
    }

    if (parsed.positionals.length < 2) {
      await writeCommandUsageError({
        context,
        command: 'trap',
        message: 'trap: missing condition',
        argvSpec: trapArgvSpec,
      });
      return { exitCode: 2 };
    }

    const [action, ...conditions] = parsed.positionals;
    const trapAction = action ?? '';
    for (const condition of conditions) {
      let disposition: WeshTrapDisposition | undefined;
      switch (trapAction) {
      case '-':
        disposition = undefined;
        break;
      case '':
        disposition = { kind: 'ignore' };
        break;
      default:
        disposition = { kind: 'run', action: trapAction };
        break;
      }

      context.setTrap({
        condition,
        disposition,
      });
    }

    return { exitCode: 0 };
  },
};
