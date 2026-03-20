import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';
import { resolvePath } from '@/services/wesh/path';

const teeArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'append', effects: [{ key: 'append', value: true }], help: { summary: 'append to the given FILEs, do not overwrite', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

async function writeAll({
  handle,
  buffer,
}: {
  handle: WeshFileHandle;
  buffer: Uint8Array;
}): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write({
      buffer,
      offset,
      length: buffer.length - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('short write');
    }
    offset += bytesWritten;
  }
}

async function closeHandle({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Ignore close failures for tee outputs.
  }
}

export const teeCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tee',
    description: 'Read from standard input and write to standard output and files',
    usage: 'tee [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: teeArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tee',
        message: `tee: ${diagnostic.message}`,
        argvSpec: teeArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tee',
        argvSpec: teeArgvSpec,
      });
      return { exitCode: 0 };
    }

    const append = parsed.optionValues.append === true;
    const outputs: Array<{ path: string; handle: WeshFileHandle }> = [];
    let exitCode = 0;

    for (const file of parsed.positionals) {
      if (file === '-') {
        continue;
      }

      const fullPath = resolvePath({
        cwd: context.cwd,
        path: file,
      });

      try {
        const handle = await context.files.open({
          path: fullPath,
          flags: {
            access: 'write',
            creation: 'if-needed',
            truncate: append ? 'preserve' : 'truncate',
            append: append ? 'append' : 'preserve',
          },
        });
        outputs.push({ path: file, handle });
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({
          text: `tee: ${file}: ${message}\n`,
        });
      }
    }

    const stdinStream = handleToStream({ handle: context.stdin });
    const reader = stdinStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        try {
          await writeAll({ handle: context.stdout, buffer: value });
        } catch {
          exitCode = 1;
        }

        for (const output of outputs) {
          try {
            await writeAll({ handle: output.handle, buffer: value });
          } catch (error: unknown) {
            exitCode = 1;
            const message = error instanceof Error ? error.message : String(error);
            await context.text().error({
              text: `tee: ${output.path}: ${message}\n`,
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
      await Promise.all(outputs.map(async ({ handle }) => closeHandle({ handle })));
    }

    return { exitCode };
  },
};
