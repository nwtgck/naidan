import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { canonicalizePathAllowingMissingLeaf, resolvePath } from '@/services/wesh/path';

const realpathArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'e', long: undefined, effects: [{ key: 'existing', value: true }], help: { summary: 'require that all path components exist', category: 'common' } },
    { kind: 'flag', short: 'm', long: undefined, effects: [{ key: 'missing', value: true }], help: { summary: 'allow missing path components', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const realpathCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'realpath',
    description: 'Print the resolved absolute path name',
    usage: 'realpath [-e|-m] FILE...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: realpathArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'realpath',
        message: `realpath: ${diagnostic.message}`,
        argvSpec: realpathArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'realpath',
        argvSpec: realpathArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'realpath',
        message: 'realpath: missing operand',
        argvSpec: realpathArgvSpec,
      });
      return { exitCode: 1 };
    }

    const allowMissing = parsed.optionValues.missing === true;
    const text = context.text();
    let exitCode = 0;

    for (const operand of parsed.positionals) {
      const fullPath = resolvePath({ cwd: context.cwd, path: operand });
      try {
        const resolved = allowMissing
          ? await canonicalizePathAllowingMissingLeaf({ context, path: fullPath })
          : (await context.files.resolve({ path: fullPath })).fullPath;
        await text.print({ text: `${resolved}\n` });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `realpath: ${operand}: ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
