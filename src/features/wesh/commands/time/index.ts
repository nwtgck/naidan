import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { isExecCompletion, type WeshBuiltinCommandContext, type WeshShellBuiltinFunction, type WeshShellExecutionResult } from '@/features/wesh/types';

const timePortableOption = {
  semantic: { kind: 'effects', effects: [{ key: 'portable', value: true }] },
  forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const timeHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const timeArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [timePortableOption, timeHelpOption],
});
const timeArgvHelp = defineArgvHelpPresentation({
  catalog: timeArgvCatalog,
  rows: [
    { forms: timePortableOption.forms, summary: 'use the portable output format', category: 'common' },
    { forms: timeHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const timeArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};
const timeUsageSummary = formatArgvUsageSummary({ presentation: timeArgvHelp });

function splitTimeArguments({
  args,
}: {
  args: string[],
}): { optionArgs: string[], commandArgs: string[] } {
  if (args.length === 1 && args[0] === '--help') {
    return { optionArgs: ['--help'], commandArgs: [] };
  }

  let commandIndex = 0;
  const optionArgs: string[] = [];
  if (args[commandIndex] === '-p') {
    optionArgs.push('-p');
    commandIndex += 1;
  }
  if (args[commandIndex] === '--') {
    commandIndex += 1;
  }

  return {
    optionArgs,
    commandArgs: args.slice(commandIndex),
  };
}

function formatPortableDuration({
  elapsedMs,
}: {
  elapsedMs: number,
}): string {
  return (elapsedMs / 1000).toFixed(2);
}

function formatDefaultDuration({
  elapsedMs,
}: {
  elapsedMs: number,
}): string {
  const totalSeconds = elapsedMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - (minutes * 60);
  return `${minutes}m${seconds.toFixed(3)}s`;
}

async function writeTimingReport({
  context,
  portable,
  elapsedMs,
}: {
  context: WeshBuiltinCommandContext,
  portable: boolean,
  elapsedMs: number,
}): Promise<void> {
  const real = portable
    ? formatPortableDuration({ elapsedMs })
    : formatDefaultDuration({ elapsedMs });
  const zero = portable
    ? formatPortableDuration({ elapsedMs: 0 })
    : formatDefaultDuration({ elapsedMs: 0 });
  const separator = portable ? ' ' : '\t';

  await context.text().error({
    text: `real${separator}${real}\nuser${separator}${zero}\nsys${separator}${zero}\n`,
  });
}

export const timeCommandImplementation = {
  fn: async ({ context, shell }) => {
    const { optionArgs, commandArgs } = splitTimeArguments({ args: context.args });
    const parsed = parseStandardArgv({
      args: optionArgs,
      catalog: timeArgvCatalog,
      policy: timeArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'time',
        message: `time: ${diagnostic.message}`,
        usageSummary: timeUsageSummary,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'time',
        optionLines: formatArgvOptionHelp({ presentation: timeArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (commandArgs.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'time',
        message: 'time: missing command operand',
        usageSummary: timeUsageSummary,
      });
      return { exitCode: 1 };
    }

    const command = commandArgs[0]!;
    const startedAt = performance.now();
    let result: WeshShellExecutionResult;
    try {
      result = await shell.evaluateCommand({ command, args: commandArgs.slice(1), functionLookup: 'allow' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== `Command not found: ${command}`) {
        throw error;
      }
      await context.text().error({
        text: `time: cannot run ${command}: No such file or directory\n`,
      });
      result = { exitCode: 127 };
    }
    if (isExecCompletion({ result })) {
      return result;
    }
    const finishedAt = performance.now();

    await writeTimingReport({
      context,
      portable: parsed.optionValues.portable === true,
      elapsedMs: Math.max(0, finishedAt - startedAt),
    });

    return result;
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'evaluateCommand'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
