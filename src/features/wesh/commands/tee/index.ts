import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { openHandleReadStream } from '@/features/wesh/utils/fs';
import { canonicalizeExistingPath, resolvePath } from '@/features/wesh/path';

const teeHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const teeAppendOption = {
  semantic: { kind: 'effects', effects: [{ key: 'append', value: true }] },
  forms: [
    { kind: 'short', name: 'a', value: { kind: 'none' } },
    { kind: 'long', name: 'append', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const teeArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'ignore-interrupts',
    'output-error',
    'version',
  ],
  definitions: [teeHelpOption, teeAppendOption],
});
const teeArgvHelp = defineArgvHelpPresentation({
  catalog: teeArgvCatalog,
  rows: [
    { forms: teeAppendOption.forms, summary: 'append to the given FILEs, do not overwrite', category: 'common' },
    { forms: teeHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const teeArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
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

export const teeCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: teeArgvCatalog,
        policy: teeArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: teeArgvCatalog,
      policy: teeArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tee',
        message: `tee: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: teeArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tee',
        optionLines: formatArgvOptionHelp({ presentation: teeArgvHelp }),
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
