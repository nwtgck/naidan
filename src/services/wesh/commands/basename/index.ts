import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { basenamePath } from '@/services/wesh/commands/_shared/path';

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
    const parsed = parseStandardArgv({
      args: context.args,
      spec: basenameArgvSpec,
    });

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
