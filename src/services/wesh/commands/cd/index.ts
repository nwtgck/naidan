import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const cdArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const cdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cd',
    description: 'Change current directory',
    usage: 'cd [path]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: cdArgvSpec,
    });

    const text = context.text();

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: `cd: ${diagnostic.message}`,
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cd',
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: 'cd: too many arguments',
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 1 };
    }

    const target = parsed.positionals[0] || '/';

    try {
      let fullPath: string;
      if (target === '-') {
        fullPath = context.env.get('OLDPWD') || '/';
      } else {
        fullPath = target.startsWith('/') ? target : `${context.cwd}/${target}`;
      }

      const res = await context.kernel.resolve({ path: fullPath });
      (() => {
        switch (res.stat.type) {
        case 'directory':
          return;
        case 'file':
          throw new Error(`Not a directory: ${target}`);
        case 'fifo':
        case 'chardev':
        case 'symlink':
          throw new Error(`Not a directory: ${target}`);
        default: {
          const _ex: never = res.stat.type;
          throw new Error(`Unhandled type: ${_ex}`);
        }
        }
      })();

      context.setCwd({ path: res.fullPath });
      return { exitCode: 0 };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cd: ${target}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
