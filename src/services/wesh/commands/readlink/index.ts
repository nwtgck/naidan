import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

const readlinkArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'f', long: 'canonicalize', effects: [{ key: 'canonicalize', value: true }], help: { summary: 'canonicalize the path and resolve symlinks' } },
    { kind: 'flag', short: 'n', long: 'no-newline', effects: [{ key: 'noNewline', value: true }], help: { summary: 'do not print the trailing newline' } },
    { kind: 'flag', short: 'e', long: 'canonicalize-existing', effects: [{ key: 'canonicalize', value: true }], help: { summary: 'canonicalize the path, requiring every component to exist' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const readlinkCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'readlink',
    description: 'Print value of a symbolic link or canonical file name',
    usage: 'readlink [-f] [-n] FILE',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: readlinkArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    const text = context.text();
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: `readlink: ${diagnostic.message}`,
        argvSpec: readlinkArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'readlink',
        argvSpec: readlinkArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length !== 1) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: 'readlink: expected exactly one operand',
        argvSpec: readlinkArgvSpec,
      });
      return { exitCode: 1 };
    }

    const inputPath = resolvePath({
      cwd: context.cwd,
      path: parsed.positionals[0]!,
    });
    const canonicalize = parsed.optionValues.canonicalize === true;
    const noNewline = parsed.optionValues.noNewline === true;

    try {
      const output = canonicalize
        ? (await context.files.resolve({ path: inputPath })).fullPath
        : await context.files.readlink({ path: inputPath });
      await text.print({ text: noNewline ? output : `${output}\n` });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `readlink: ${parsed.positionals[0]}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
