import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { exists, writeFile } from '@/services/wesh/utils/fs';

const touchArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const touchCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'touch',
    description: 'Update file timestamps or create empty files',
    usage: 'touch path...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: touchArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: `touch: ${diagnostic.message}`,
        argvSpec: touchArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'touch',
        argvSpec: touchArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'touch',
        message: 'touch: missing file operand',
        argvSpec: touchArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();

    for (const p of parsed.positionals) {
      if (p === undefined) continue;
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        const isExists = await exists({ files: context.files, path: fullPath });

        if (!isExists) {
          // Create empty file
          await writeFile({ files: context.files, path: fullPath, data: new Uint8Array(0) });
        } else {
          // Just update mtime - we don't have a direct utimes yet,
          // so we could potentially open and close it if we want to simulate it,
          // but the current VFS doesn't support manual mtime update via open.
          const handle = await context.files.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await handle.close();
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `touch: cannot touch '${p}': ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
