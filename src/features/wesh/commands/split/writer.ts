import type { WeshCommandContext, WeshFileHandle, WeshEfficientFileWriter } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import type { SplitSuffixGenerator } from './suffix';

export interface SplitOutputController {
  write({ chunk }: { chunk: Uint8Array }): Promise<void>,
  closeCurrent(): Promise<void>,
  closeAll(): Promise<void>,
}

type OpenOutput =
  | { kind: 'efficient', path: string, writer: WeshEfficientFileWriter }
  | { kind: 'handle', path: string, handle: WeshFileHandle };

function formatError({
  error,
}: {
  error: unknown,
}): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeOutput({
  output,
}: {
  output: OpenOutput,
}): Promise<void> {
  switch (output.kind) {
  case 'efficient':
    await output.writer.close();
    return;
  case 'handle':
    await output.handle.close();
    return;
  default: {
    const _ex: never = output;
    throw new Error(`Unhandled output kind: ${JSON.stringify(_ex)}`);
  }
  }
}

async function abortOutput({
  output,
  reason,
}: {
  output: OpenOutput,
  reason: unknown,
}): Promise<void> {
  switch (output.kind) {
  case 'efficient':
    await output.writer.abort({ reason });
    return;
  case 'handle':
    await output.handle.close();
    return;
  default: {
    const _ex: never = output;
    throw new Error(`Unhandled output kind: ${JSON.stringify(_ex)}`);
  }
  }
}

async function writeOutput({
  output,
  chunk,
}: {
  output: OpenOutput,
  chunk: Uint8Array,
}): Promise<void> {
  switch (output.kind) {
  case 'efficient':
    await output.writer.write({ chunk });
    return;
  case 'handle':
    await writeAllBytesToHandle({ handle: output.handle, data: chunk });
    return;
  default: {
    const _ex: never = output;
    throw new Error(`Unhandled output kind: ${JSON.stringify(_ex)}`);
  }
  }
}

export function createSplitOutputController({
  context,
  suffixGenerator,
  verbose,
  rejectPath,
}: {
  context: WeshCommandContext,
  suffixGenerator: SplitSuffixGenerator,
  verbose: boolean,
  rejectPath: (({ path }: { path: string }) => Promise<string | undefined>) | undefined,
}): SplitOutputController {
  let current: OpenOutput | undefined;
  const verboseWriter = createBufferedTextWriter({
    handle: context.stdout,
    maxBufferLength: 16 * 1024,
  });

  const openNext = async (): Promise<OpenOutput> => {
    const path = suffixGenerator.nextName();
    const rejectionMessage = await rejectPath?.({ path });
    if (rejectionMessage !== undefined) {
      throw new Error(rejectionMessage);
    }

    if (verbose) {
      await verboseWriter.write({ text: `creating file '${path}'\n` });
    }

    try {
      const efficient = await context.files.tryCreateFileWriterEfficiently({
        path,
        mode: 'truncate',
      });

      switch (efficient.kind) {
      case 'writer':
        return { kind: 'efficient', path, writer: efficient.writer };
      case 'fallback_required':
        break;
      default: {
        const _ex: never = efficient;
        throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
      }
      }

      const handle = await context.files.open({
        path,
        flags: {
          access: 'write',
          creation: 'if-needed',
          truncate: 'truncate',
          append: 'preserve',
        },
      });
      return { kind: 'handle', path, handle };
    } catch (error: unknown) {
      throw new Error(`cannot open '${path}' for writing: ${formatError({ error })}`);
    }
  };

  return {
    async write({
      chunk,
    }: {
      chunk: Uint8Array,
    }): Promise<void> {
      if (chunk.byteLength === 0) {
        return;
      }

      current ??= await openNext();
      try {
        await writeOutput({ output: current, chunk });
      } catch (error: unknown) {
        const failedOutput = current;
        current = undefined;
        await abortOutput({ output: failedOutput, reason: error });
        throw new Error(`cannot write '${failedOutput.path}': ${formatError({ error })}`);
      }
    },

    async closeCurrent(): Promise<void> {
      if (current === undefined) {
        return;
      }

      const closing = current;
      current = undefined;
      await closeOutput({ output: closing });
    },

    async closeAll(): Promise<void> {
      await this.closeCurrent();
      await verboseWriter.flush();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createSplitOutputController,
};
