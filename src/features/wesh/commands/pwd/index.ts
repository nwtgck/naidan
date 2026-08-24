import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { canonicalizeExistingPath } from '@/features/wesh/path';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const pwdArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'L', long: 'logical', effects: [{ key: 'mode', value: 'logical' }], help: { summary: 'use the logical current directory' } },
    { kind: 'flag', short: 'P', long: 'physical', effects: [{ key: 'mode', value: 'physical' }], help: { summary: 'avoid symbolic links in the current directory' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const pwdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd [-LP]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({
        args: context.args,
        spec: pwdArgvSpec,
      }),
      spec: pwdArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'pwd',
        message: `pwd: ${diagnostic.message}`,
        argvSpec: pwdArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'pwd',
        argvSpec: pwdArgvSpec,
      });
      return { exitCode: 0 };
    }

    const pathMode = (parsed.optionValues.mode ?? 'logical') as 'logical' | 'physical';
    const text = context.text();
    let path: string;
    try {
      path = await (async (): Promise<string> => {
        switch (pathMode) {
        case 'logical':
          return context.cwd;
        case 'physical':
          return canonicalizeExistingPath({ context, path: context.cwd });
        default: {
          const _ex: never = pathMode;
          throw new Error(`Unhandled pwd path mode: ${_ex}`);
        }
        }
      })();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `pwd: ${message}\n` });
      return { exitCode: 1 };
    }

    await text.print({ text: path + '\n' });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
