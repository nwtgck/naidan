import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

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

function parseHexadecimalFloat({
  value,
}: {
  value: string,
}): number {
  const sign = value.startsWith('-') ? -1 : 1;
  const unsigned = value.replace(/^[+-]/u, '').slice(2);
  const [mantissaText, exponentText] = unsigned.split(/[pP]/u, 2);
  const [integerText = '', fractionText = ''] = mantissaText!.split('.', 2);
  let magnitude = integerText.length === 0 ? 0 : Number.parseInt(integerText, 16);
  for (let index = 0; index < fractionText.length; index += 1) {
    magnitude += Number.parseInt(fractionText[index]!, 16) / (16 ** (index + 1));
  }
  if (magnitude === 0) {
    return sign * 0;
  }
  return sign * magnitude * (2 ** Number(exponentText ?? 0));
}

function isNegativeNonzeroNumericOperand({
  value,
}: {
  value: string,
}): boolean {
  if (!value.startsWith('-')) {
    return false;
  }

  const unsigned = value.slice(1);
  if (/^0[xX]/u.test(unsigned)) {
    const [mantissa = ''] = unsigned.slice(2).split(/[pP]/u, 1);
    return /[1-9a-fA-F]/u.test(mantissa);
  }

  const [significand = ''] = unsigned.split(/[eE]/u, 1);
  return /[1-9]/u.test(significand);
}

function parseSleepOperand({
  value,
}: {
  value: string,
}): { ok: true, seconds: number } | { ok: false } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const infinitySuffix = (() => {
    const finalCharacter = numericText.at(-1);
    switch (finalCharacter) {
    case 's':
    case 'm':
    case 'h':
    case 'd':
      return finalCharacter;
    case undefined:
      return '';
    default:
      return '';
    }
  })();
  const infinityOperand = (() => {
    switch (infinitySuffix) {
    case '':
      return numericText;
    case 's':
    case 'm':
    case 'h':
    case 'd':
      return numericText.slice(0, -1);
    default: {
      const _ex: never = infinitySuffix;
      throw new Error(`Unhandled sleep suffix: ${_ex}`);
    }
    }
  })();
  if (/^\+?(?:inf|infinity)$/iu.test(infinityOperand)) {
    return { ok: true, seconds: Number.POSITIVE_INFINITY };
  }

  const match = numericText.match(/^([+-]?(?:(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?)|(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)))([smhd]?)$/u);
  if (match === null) {
    return { ok: false };
  }

  const numericOperand = match[1] ?? '';
  const amount = /^[+-]?0[xX]/u.test(numericOperand)
    ? parseHexadecimalFloat({ value: numericOperand })
    : Number.parseFloat(numericOperand);
  if (
    Number.isNaN(amount)
    || amount < 0
    || (amount === 0 && isNegativeNonzeroNumericOperand({ value: numericOperand }))
  ) {
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
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: sleepArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: sleepArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'sleep',
        message: `sleep: ${diagnostic.message}`,
        argvSpec: sleepArgvSpec,
      });
      return { exitCode: 1 };
    }

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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
