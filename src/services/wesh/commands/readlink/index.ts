import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

export const readlinkCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'readlink',
    description: 'Print value of a symbolic link or canonical file name',
    usage: 'readlink [-f] [-n] FILE',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'f', long: 'canonicalize', effects: [{ key: 'canonicalize', value: true }], help: { summary: 'canonicalize the path and resolve symlinks' } },
          { kind: 'flag', short: 'n', long: 'no-newline', effects: [{ key: 'noNewline', value: true }], help: { summary: 'do not print the trailing newline' } },
          { kind: 'flag', short: 'e', long: 'canonicalize-existing', effects: [{ key: 'canonicalize', value: true }], help: { summary: 'canonicalize the path, requiring every component to exist' } },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    const text = context.text();
    if (diagnostic !== undefined) {
      await text.error({ text: `readlink: ${diagnostic.message}\n` });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length !== 1) {
      await text.error({ text: 'readlink: expected exactly one operand\n' });
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
        ? (await context.kernel.resolve({ path: inputPath })).fullPath
        : await context.kernel.readlink({ path: inputPath });
      await text.print({ text: noNewline ? output : `${output}\n` });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `readlink: ${parsed.positionals[0]}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
