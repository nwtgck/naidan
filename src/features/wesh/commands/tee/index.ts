import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { openHandleReadStream } from '@/features/wesh/utils/fs';
import { canonicalizeExistingPath, resolvePath } from '@/features/wesh/path';

const teeArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'a', long: 'append', effects: [{ key: 'append', value: true }], help: { summary: 'append to the given FILEs, do not overwrite', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};


async function writeAll({
  handle,
  buffer,
}: {
  handle: WeshFileHandle,
  buffer: Uint8Array,
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
  handle: WeshFileHandle,
}): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Ignore close failures for tee outputs.
  }
}

async function closeWriter({
  writer,
}: {
  writer: WeshEfficientFileWriter,
}): Promise<void> {
  try {
    await writer.close();
  } catch {
    // Ignore close failures for tee outputs.
  }
}

type TeeOutput =
  | { kind: 'handle', path: string, handle: WeshFileHandle }
  | { kind: 'writer', path: string, writer: WeshEfficientFileWriter };

async function getAppendOutputIdentity({
  context,
  fullPath,
}: {
  context: WeshCommandContext,
  fullPath: string,
}): Promise<string> {
  try {
    return await canonicalizeExistingPath({ context, path: fullPath });
  } catch {
    // Preserve the open operation as the owner of missing, dangling-link, and
    // permission diagnostics. Existing aliases share a canonical identity; a
    // path that cannot be canonicalized remains keyed by its resolved spelling.
    return fullPath;
  }
}

async function writeTeeOutput({
  output,
  buffer,
}: {
  output: TeeOutput,
  buffer: Uint8Array,
}): Promise<void> {
  switch (output.kind) {
  case 'handle':
    await writeAll({
      handle: output.handle,
      buffer,
    });
    return;
  case 'writer':
    await output.writer.write({
      chunk: buffer,
    });
    return;
  default: {
    const _ex: never = output;
    throw new Error(`Unhandled tee output target: ${JSON.stringify(_ex)}`);
  }
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
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: teeArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
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
    const outputs: TeeOutput[] = [];
    const appendOutputsByPath = new Map<string, TeeOutput>();
    let exitCode = 0;

    for (const file of parsed.positionals) {
      const fullPath = resolvePath({
        cwd: context.cwd,
        path: file,
      });

      const appendOutputIdentity = append
        ? await getAppendOutputIdentity({ context, fullPath })
        : undefined;
      if (appendOutputIdentity !== undefined) {
        const existingOutput = appendOutputsByPath.get(appendOutputIdentity);
        if (existingOutput !== undefined) {
          outputs.push(existingOutput);
          continue;
        }
      }

      try {
        if (context.files.tryCreateFileWriterEfficiently !== undefined) {
          const writerResult = await context.files.tryCreateFileWriterEfficiently({
            path: fullPath,
            mode: append ? 'append' : 'truncate',
          });
          switch (writerResult.kind) {
          case 'writer': {
            const output = { kind: 'writer', path: file, writer: writerResult.writer } as const;
            outputs.push(output);
            if (appendOutputIdentity !== undefined) appendOutputsByPath.set(appendOutputIdentity, output);
            break;
          }
          case 'fallback_required': {
            const handle = await context.files.open({
              path: fullPath,
              flags: {
                access: 'write',
                creation: 'if-needed',
                truncate: append ? 'preserve' : 'truncate',
                append: append ? 'append' : 'preserve',
              },
            });
            const output = { kind: 'handle', path: file, handle } as const;
            outputs.push(output);
            if (appendOutputIdentity !== undefined) appendOutputsByPath.set(appendOutputIdentity, output);
            break;
          }
          default: {
            const _ex: never = writerResult;
            throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
          }
          }
        } else {
          const handle = await context.files.open({
            path: fullPath,
            flags: {
              access: 'write',
              creation: 'if-needed',
              truncate: append ? 'preserve' : 'truncate',
              append: append ? 'append' : 'preserve',
            },
          });
          const output = { kind: 'handle', path: file, handle } as const;
          outputs.push(output);
          if (appendOutputIdentity !== undefined) appendOutputsByPath.set(appendOutputIdentity, output);
        }
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({
          text: `tee: ${file}: ${message}\n`,
        });
      }
    }

    const writeInputBlock = async ({
      buffer,
    }: {
      buffer: Uint8Array,
    }): Promise<void> => {
      try {
        await writeAll({ handle: context.stdout, buffer });
      } catch {
        exitCode = 1;
      }

      for (const output of outputs) {
        try {
          await writeTeeOutput({ output, buffer });
        } catch (error: unknown) {
          exitCode = 1;
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({
            text: `tee: ${output.path}: ${message}\n`,
          });
        }
      }
    };

    const stdinStream = openHandleReadStream({ handle: context.stdin });
    const reader = stdinStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeInputBlock({ buffer: value });
      }
    } finally {
      reader.releaseLock();
      await Promise.all([...new Set(outputs)].map(async (output) => {
        switch (output.kind) {
        case 'handle':
          await closeHandle({ handle: output.handle });
          return;
        case 'writer':
          await closeWriter({ writer: output.writer });
          return;
        default: {
          const _ex: never = output;
          throw new Error(`Unhandled tee output target: ${JSON.stringify(_ex)}`);
        }
        }
      }));
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
