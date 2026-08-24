import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

const timeArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'p',
      long: undefined,
      effects: [{ key: 'portable', value: true }],
      help: { summary: 'use the portable output format', category: 'common' },
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
  context: WeshCommandContext,
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

export const timeCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'time',
    description: 'Measure command execution time',
    usage: 'time [-p] COMMAND [ARG]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { optionArgs, commandArgs } = splitTimeArguments({ args: context.args });
    const parsed = parseStandardArgv({
      args: optionArgs,
      spec: timeArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'time',
        message: `time: ${diagnostic.message}`,
        argvSpec: timeArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'time',
        argvSpec: timeArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (commandArgs.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'time',
        message: 'time: missing command operand',
        argvSpec: timeArgvSpec,
      });
      return { exitCode: 1 };
    }

    const command = commandArgs[0]!;
    const startedAt = performance.now();
    let result: WeshCommandResult;
    try {
      result = await context.executeCommand({
        command,
        args: commandArgs.slice(1),
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== `Command not found: ${command}`) throw error;
      await context.text().error({
        text: `time: cannot run ${command}: No such file or directory\n`,
      });
      result = { exitCode: 127 };
    }
    const finishedAt = performance.now();

    await writeTimingReport({
      context,
      portable: parsed.optionValues.portable === true,
      elapsedMs: Math.max(0, finishedAt - startedAt),
    });

    return result;
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
