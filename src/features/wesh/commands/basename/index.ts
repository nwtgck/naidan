import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { basenamePath } from '@/features/wesh/commands/_shared/path';

function splitBasenameArguments({
  args,
}: {
  args: string[],
}): {
  optionArguments: string[],
  positionalArguments: string[],
} {
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;

    if (token === '--') {
      return {
        optionArguments: args.slice(0, index),
        positionalArguments: args.slice(index + 1),
      };
    }

    if (token === '-' || !token.startsWith('-')) break;

    if (token === '--suffix') {
      index += Math.min(2, args.length - index);
      continue;
    }

    if (token.startsWith('--suffix=')) {
      index += 1;
      continue;
    }

    if (token.startsWith('-') && !token.startsWith('--')) {
      const suffixOptionIndex = token.slice(1).indexOf('s');
      if (suffixOptionIndex >= 0 && suffixOptionIndex === token.length - 2) {
        index += Math.min(2, args.length - index);
        continue;
      }
    }

    index += 1;
  }

  return {
    optionArguments: args.slice(0, index),
    positionalArguments: args.slice(index),
  };
}

const basenameArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'multiple', effects: [{ key: 'multiple', value: true }], help: { summary: 'support multiple arguments and treat each as NAME', category: 'common' } },
    { kind: 'value', short: 's', long: 'suffix', key: 'suffix', valueName: 'SUFFIX', allowAttachedValue: true, parseValue: undefined, help: { summary: 'remove a trailing SUFFIX; implies -a', valueName: 'SUFFIX', category: 'common' } },
    { kind: 'flag', short: 'z', long: 'zero', effects: [{ key: 'zero', value: true }], help: { summary: 'end each output line with NUL, not newline', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const basenameCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'basename',
    description: 'Strip directory and suffix from filenames',
    usage: 'basename [OPTION]... NAME...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArguments = splitBasenameArguments({ args: context.args });
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: splitArguments.optionArguments,
        spec: basenameArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: basenameArgvSpec,
    });
    for (const positional of splitArguments.positionalArguments) parsed.positionals.push(positional);

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: `basename: ${diagnostic.message}`,
        argvSpec: basenameArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'basename',
        argvSpec: basenameArgvSpec,
      });
      return { exitCode: 0 };
    }

    const suffixValue = typeof parsed.optionValues.suffix === 'string' ? parsed.optionValues.suffix : undefined;
    const multiple = parsed.optionValues.multiple === true || suffixValue !== undefined;
    const zero = parsed.optionValues.zero === true;
    const separator = zero ? '\0' : '\n';
    const text = context.text();

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: 'basename: missing operand',
        argvSpec: basenameArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (!multiple && parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: 'basename: extra operand',
        argvSpec: basenameArgvSpec,
      });
      return { exitCode: 1 };
    }

    const suffix = suffixValue ?? (multiple ? undefined : parsed.positionals[1]);
    const names = multiple ? parsed.positionals : [parsed.positionals[0]!];

    for (const name of names) {
      await text.print({
        text: `${basenamePath({ path: name, suffix })}${separator}`,
      });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
