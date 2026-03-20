import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const mkdirCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'mkdir',
    description: 'Create directories',
    usage: 'mkdir [-p] path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'parents', value: true }], help: { summary: 'make parent directories as needed' } },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'mkdir',
        message: `mkdir: ${parsed.diagnostics[0]!.message}`,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'mkdir',
        message: 'mkdir: missing operand',
      });
      return { exitCode: 1 };
    }

    const recursive = parsed.optionValues.parents === true;
    const text = context.text();

    for (const p of parsed.positionals) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await context.kernel.mkdir({ path: fullPath, recursive });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `mkdir: cannot create directory '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
