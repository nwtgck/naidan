import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

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

function formatPortableDuration({
  elapsedMs,
}: {
  elapsedMs: number;
}): string {
  return (elapsedMs / 1000).toFixed(2);
}

function formatDefaultDuration({
  elapsedMs,
}: {
  elapsedMs: number;
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
  context: WeshCommandContext;
  portable: boolean;
  elapsedMs: number;
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
    const parsed = parseStandardArgv({
      args: context.args,
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

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'time',
        message: 'time: missing command operand',
        argvSpec: timeArgvSpec,
      });
      return { exitCode: 1 };
    }

    const startedAt = performance.now();
    const result = await context.executeCommand({
      command: parsed.positionals[0]!,
      args: parsed.positionals.slice(1),
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
    });
    const finishedAt = performance.now();

    await writeTimingReport({
      context,
      portable: parsed.optionValues.portable === true,
      elapsedMs: Math.max(0, finishedAt - startedAt),
    });

    return result;
  },
};
