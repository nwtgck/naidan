import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const historyArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

const maximumPositiveHistoryCountText = '9223372036854775807';
const maximumNegativeHistoryMagnitudeText = '9223372036854775808';

function parseHistoryCount({
  value,
}: {
  value: string,
}): bigint | undefined {
  if (value.length === 0) {
    return undefined;
  }

  let index = 0;
  let negative = false;
  switch (value[0]) {
  case '+':
    index = 1;
    break;
  case '-':
    index = 1;
    negative = true;
    break;
  default:
    break;
  }
  if (index === value.length) {
    return undefined;
  }

  while (index < value.length && value.charCodeAt(index) === 0x30) {
    index += 1;
  }
  if (index === value.length) {
    return 0n;
  }

  const firstSignificantDigitIndex = index;
  for (; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x30 || codePoint > 0x39) {
      return undefined;
    }
  }

  const maximumMagnitudeText = negative
    ? maximumNegativeHistoryMagnitudeText
    : maximumPositiveHistoryCountText;
  const significantDigitCount = value.length - firstSignificantDigitIndex;
  if (significantDigitCount > maximumMagnitudeText.length) {
    return undefined;
  }
  const significantDigits = value.slice(firstSignificantDigitIndex);
  if (
    significantDigitCount === maximumMagnitudeText.length
    && significantDigits > maximumMagnitudeText
  ) {
    return undefined;
  }

  return BigInt(significantDigits);
}

export const historyCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({
        args: context.args,
        spec: historyArgvSpec,
      }),
      spec: historyArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'history',
        message: `history: ${diagnostic.message}`,
        argvSpec: historyArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'history',
        argvSpec: historyArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await context.text().error({ text: 'history: too many arguments\n' });
      return { exitCode: 1 };
    }

    let count: bigint | undefined;
    const countOperand = parsed.positionals[0];
    if (countOperand !== undefined) {
      count = parseHistoryCount({ value: countOperand });
      if (count === undefined) {
        await context.text().error({
          text: `history: ${countOperand}: numeric argument required\n`,
        });
        return { exitCode: 1 };
      }
    }

    const text = context.text();
    const historyList = context.getHistory();
    const startIndex = count === undefined || count >= BigInt(historyList.length)
      ? 0
      : historyList.length - Number(count);
    for (let i = startIndex; i < historyList.length; i++) {
      const line = `${(i + 1).toString().padStart(5)}  ${historyList[i]}\n`;
      await text.print({ text: line });
    }
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
