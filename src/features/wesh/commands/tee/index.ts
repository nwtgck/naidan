import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { canonicalizePathAllowingMissingLeaf, toAbsolutePath } from '@/features/wesh/path';

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

type TeeOutput =
  | { kind: 'handle', path: string, handle: WeshFileHandle }
  | { kind: 'writer', path: string, writer: WeshEfficientFileWriter };

async function openTeeOutput({
  context,
  file,
  fullPath,
  append,
}: {
  context: WeshCommandContext,
  file: string,
  fullPath: string,
  append: boolean,
}): Promise<TeeOutput> {
  const efficient = await context.files.tryCreateFileWriterEfficiently?.({
    path: fullPath,
    mode: append ? 'append' : 'truncate',
    sharedOutput: context.stdout,
  });
  if (efficient !== undefined) {
    switch (efficient.kind) {
    case 'writer':
      return { kind: 'writer', path: file, writer: efficient.writer };
    case 'fallback_required':
      break;
    default: {
      const _ex: never = efficient;
      throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const handle = await context.files.open({
    path: fullPath,
    flags: {
      access: 'write',
      creation: 'if-needed',
      truncate: append ? 'preserve' : 'truncate',
      append: append ? 'append' : 'preserve',
    },
  });
  return { kind: 'handle', path: file, handle };
}

async function finishTeeOutput({
  output,
  failedWrite,
}: {
  output: TeeOutput,
  failedWrite: { error: unknown } | undefined,
}): Promise<void> {
  switch (output.kind) {
  case 'handle':
    await output.handle.close();
    return;
  case 'writer':
    // The writer can stage bytes until close. Discard failed writes and keep
    // the original diagnostic if abort also rejects.
    if (failedWrite !== undefined) {
      await output.writer.abort({ reason: failedWrite.error }).catch(() => undefined);
      return;
    }
    try {
      await output.writer.close();
    } catch (error: unknown) {
      await output.writer.abort({ reason: error }).catch(() => undefined);
      throw error;
    }
    return;
  default: {
    const _ex: never = output;
    throw new Error(`Unhandled tee output target: ${JSON.stringify(_ex)}`);
  }
  }
}

async function getOutputIdentity({
  context,
  fullPath,
}: {
  context: WeshCommandContext,
  fullPath: string,
}): Promise<string> {
  try {
    const entry = await context.files.resolveEntry({ path: fullPath, finalSymlinkTreatment: 'follow' });
    return entry.fullPath;
  } catch {
    // For a new file, the existing parent is enough to identify its name.
  }
  try {
    return await canonicalizePathAllowingMissingLeaf({ context, path: fullPath });
  } catch {
    // Let open report the original error when a parent cannot be resolved.
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
    const stdout: TeeOutput = { kind: 'handle', path: "'standard output'", handle: context.stdout };
    const outputs: TeeOutput[] = [stdout];
    const outputsByPath = new Map<string, TeeOutput>();
    const failedWrites = new Map<TeeOutput, { error: unknown }>();
    let exitCode = 0;
    const wasSignaled = () => context.process.getWaitStatus()?.kind === 'signaled';
    const reportIoError = async ({
      target,
      error,
    }: {
      target: string,
      error: unknown,
    }): Promise<void> => {
      exitCode = 1;
      if (!wasSignaled()) {
        const message = error instanceof Error ? error.message : String(error);
        // A failure while writing the diagnostic must leave other outputs active.
        await context.text().error({ text: `tee: ${target}: ${message}\n` }).catch(() => undefined);
      }
    };

    try {
      for (const file of parsed.positionals) {
        if (wasSignaled()) {
          break;
        }
        const fullPath = toAbsolutePath({ cwd: context.cwd, path: file });
        const outputIdentity = parsed.positionals.length > 1
          ? await getOutputIdentity({ context, fullPath })
          : undefined;
        if (outputIdentity !== undefined) {
          const existingOutput = outputsByPath.get(outputIdentity);
          if (existingOutput !== undefined) {
            if (append) {
              outputs.push(existingOutput);
            }
            continue;
          }
        }
        try {
          const output = await openTeeOutput({ context, file, fullPath, append });
          outputs.push(output);
          if (outputIdentity !== undefined) {
            outputsByPath.set(outputIdentity, output);
          }
        } catch (error: unknown) {
          await reportIoError({ target: file, error });
        }
      }

      const outputCount = new Set(outputs).size;
      const buffer = new Uint8Array(64 * 1024);
      while (failedWrites.size < outputCount && !wasSignaled()) {
        let bytesRead: number;
        try {
          ({ bytesRead } = await context.stdin.read({ buffer }));
        } catch (error: unknown) {
          await reportIoError({ target: 'read error', error });
          break;
        }
        if (bytesRead === 0) {
          break;
        }
        const chunk = buffer.subarray(0, bytesRead);
        for (const output of outputs) {
          if (wasSignaled()) {
            break;
          }
          if (failedWrites.has(output)) {
            continue;
          }
          try {
            await writeTeeOutput({ output, buffer: chunk });
          } catch (error: unknown) {
            failedWrites.set(output, { error });
            await reportIoError({ target: output.path, error });
          }
        }
      }
    } finally {
      // Standard descriptors are borrowed. Close each opened file output
      // once, including files that share a writer through repeated operands.
      const fileOutputs = [...new Set(outputs.slice(1))];
      const closeFailures = await Promise.all(fileOutputs.map(async (output) => {
        try {
          await finishTeeOutput({ output, failedWrite: failedWrites.get(output) });
          return undefined;
        } catch (error: unknown) {
          return { target: output.path, error };
        }
      }));
      for (const failure of closeFailures) {
        if (failure !== undefined) {
          await reportIoError(failure);
        }
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
