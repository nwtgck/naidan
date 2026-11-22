import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshShellBuiltinFunction, WeshCommandResult } from '@/features/wesh/types';

const historyOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const historyArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: historyOptions,
  nonExecutableLongOptions: [],
});
const historyArgvHelp = defineArgvHelpPresentation({ catalog: historyArgvCatalog, rows: historyOptions });
const historyArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
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

export const historyCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: historyArgvCatalog,
      policy: historyArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'history',
        message: `history: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: historyArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'history',
        optionLines: formatArgvOptionHelp({ presentation: historyArgvHelp }),
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
    const historyList = shell.getHistory();
    const startIndex = count === undefined || count >= BigInt(historyList.length)
      ? 0
      : historyList.length - Number(count);
    for (let i = startIndex; i < historyList.length; i++) {
      const line = `${(i + 1).toString().padStart(5)}  ${historyList[i]}\n`;
      await text.print({ text: line });
    }
    return { exitCode: 0 };
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'getHistory'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
