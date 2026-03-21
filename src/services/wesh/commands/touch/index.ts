import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { exists, writeFile } from '@/services/wesh/utils/fs';

const touchArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'r',
      long: 'reference',
      key: 'reference',
      valueName: 'FILE',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { valueName: 'FILE', summary: 'use this file timestamps instead of current time', category: 'common' },
    },
    { kind: 'flag', short: 'c', long: 'no-create', effects: [{ key: 'noCreate', value: true }], help: { summary: 'do not create any files', category: 'common' } },
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
    usage: 'touch [-c] [-r FILE] path...',
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
    const noCreate = parsed.optionValues.noCreate === true;
    const referencePath = parsed.optionValues.reference as string | undefined;
    let exitCode = 0;

    if (referencePath !== undefined) {
      try {
        await context.files.stat({
          path: referencePath.startsWith('/') ? referencePath : (context.cwd === '/' ? `/${referencePath}` : `${context.cwd}/${referencePath}`),
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `touch: failed to get attributes of '${referencePath}': ${message}\n` });
        return { exitCode: 1 };
      }
    }

    for (const p of parsed.positionals) {
      if (p === undefined) continue;
      try {
        const fullPath = p.startsWith('/') ? p : (context.cwd === '/' ? `/${p}` : `${context.cwd}/${p}`);
        const isExists = await exists({ files: context.files, path: fullPath });

        if (!isExists) {
          if (noCreate) {
            continue;
          }
          // Create empty file
          await writeFile({ files: context.files, path: fullPath, data: new Uint8Array(0) });
        } else {
          const handle = await context.files.open({
            path: fullPath,
            flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          try {
            const stat = await handle.stat();
            await handle.write({
              buffer: new Uint8Array(0),
              position: stat.size,
            });
          } finally {
            await handle.close();
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `touch: cannot touch '${p}': ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
