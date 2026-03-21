import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const sleepArgvSpec: StandardArgvParserSpec = {
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

function parseSleepOperand({
  value,
}: {
  value: string;
}): { ok: true; seconds: number } | { ok: false } {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)([smhd]?)$/);
  if (match === null) {
    return { ok: false };
  }

  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount)) {
    return { ok: false };
  }

  const multiplier = (() => {
    switch (match[2] ?? '') {
    case '':
    case 's':
      return 1;
    case 'm':
      return 60;
    case 'h':
      return 60 * 60;
    case 'd':
      return 60 * 60 * 24;
    default:
      return undefined;
    }
  })();

  if (multiplier === undefined) {
    return { ok: false };
  }

  return {
    ok: true,
    seconds: amount * multiplier,
  };
}

export const sleepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sleep',
    description: 'Delay for a specified amount of time',
    usage: 'sleep NUMBER[SUFFIX]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: sleepArgvSpec,
    });

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'sleep',
        argvSpec: sleepArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'sleep',
        message: 'sleep: missing operand',
        argvSpec: sleepArgvSpec,
      });
      return { exitCode: 1 };
    }

    let seconds = 0;
    for (const operand of parsed.positionals) {
      const parsedOperand = parseSleepOperand({
        value: operand,
      });
      if (!parsedOperand.ok) {
        await writeCommandUsageError({
          context,
          command: 'sleep',
          message: `sleep: invalid time interval '${operand}'`,
          argvSpec: sleepArgvSpec,
        });
        return { exitCode: 1 };
      }
      seconds += parsedOperand.seconds;
    }

    const waitStatus = await context.process.waitForSignalOrTimeout({
      timeoutMs: seconds * 1000,
    });
    if (waitStatus !== undefined) {
      return {
        exitCode: 0,
        waitStatus,
      };
    }

    return { exitCode: 0 };
  },
};
