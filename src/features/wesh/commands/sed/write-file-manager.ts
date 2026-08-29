import { createBufferedCommandDataWriter, encodeCommandDataText } from "@/features/wesh/commands/_shared/data-codec";
import { normalizePath } from "@/features/wesh/path";
import type {
  WeshCommandContext,
  WeshEfficientFileWriter,
} from "@/features/wesh/types";

export interface SedWriteOutput {
  text: string;
  hadNewline: boolean;
}

export interface SedWriteFileManager {
  write({ path, output }: { path: string; output: SedWriteOutput }): Promise<void>;
  close(): Promise<void>;
  abort({ reason }: { reason: unknown }): Promise<void>;
}

interface SedWriteFileState {
  target: SedTextFileTarget;
  previousOutputMissingNewline: boolean;
}

interface SedTextFileTarget {
  write({ text }: { text: string }): Promise<void>;
  close(): Promise<void>;
  abort({ reason }: { reason: unknown }): Promise<void>;
}

function createBufferedEfficientSedWriter({
  writer,
  maxBufferLength,
}: {
  writer: WeshEfficientFileWriter;
  maxBufferLength: number;
}): SedTextFileTarget {
  let chunks: string[] = [];
  let bufferedLength = 0;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) return;
    const text = chunks.join("");
    chunks = [];
    bufferedLength = 0;
    await writer.write({ chunk: encodeCommandDataText({ text }) });
  };

  return {
    async write({ text }) {
      if (closed)
        throw new Error("sed: attempted to write to a closed output file");
      chunks.push(text);
      bufferedLength += text.length;
      if (bufferedLength >= maxBufferLength) await flush();
    },
    async close() {
      if (closed) return;
      try {
        await flush();
        await writer.close();
        closed = true;
      } catch (error: unknown) {
        chunks = [];
        bufferedLength = 0;
        try {
          await writer.abort({ reason: error });
        } catch {
          // Preserve the write or close failure.
        }
        closed = true;
        throw error;
      }
    },
    async abort({ reason }) {
      if (closed) return;
      closed = true;
      chunks = [];
      bufferedLength = 0;
      await writer.abort({ reason });
    },
  };
}

async function createSedTextFileTarget({
  context,
  path,
  maxBufferLength,
}: {
  context: WeshCommandContext;
  path: string;
  maxBufferLength: number;
}): Promise<SedTextFileTarget> {
  const efficient = await context.files.tryCreateFileWriterEfficiently({
    path,
    mode: "truncate",
  });
  switch (efficient.kind) {
  case "writer":
    return createBufferedEfficientSedWriter({
      writer: efficient.writer,
      maxBufferLength,
    });
  case "fallback_required":
    break;
  default: {
    const _ex: never = efficient;
    throw new Error(
      `Unhandled sed efficient writer result: ${JSON.stringify(_ex)}`,
    );
  }
  }

  const handle = await context.files.open({
    path,
    flags: {
      access: "write",
      creation: "if-needed",
      truncate: "truncate",
      append: "preserve",
    },
  });
  const writer = createBufferedCommandDataWriter({
    handle,
    maxBufferLength,
  });
  let closed = false;
  return {
    write: writer.write,
    async close() {
      if (closed) return;
      let failure: unknown;
      try {
        await writer.flush();
      } catch (error: unknown) {
        failure = error;
      }
      try {
        await handle.close();
      } catch (error: unknown) {
        failure =
          failure === undefined
            ? error
            : new AggregateError(
              [failure, error],
              "sed: failed to flush and close output file",
            );
      }
      closed = true;
      if (failure !== undefined) throw failure;
    },
    async abort() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

export async function createSedWriteFileManager({
  context,
  paths,
  recordTerminator,
  encodeText,
  maxBufferLength,
}: {
  context: WeshCommandContext;
  paths: readonly string[];
  recordTerminator: string;
  encodeText: ({ text }: { text: string }) => string;
  maxBufferLength: number;
}): Promise<SedWriteFileManager> {
  const targets = new Map<string, SedWriteFileState>();
  try {
    for (const path of paths) {
      if (targets.has(path)) continue;
      targets.set(path, {
        target: await createSedTextFileTarget({
          context,
          path: normalizePath({ cwd: context.cwd, path }),
          maxBufferLength,
        }),
        previousOutputMissingNewline: false,
      });
    }
  } catch (error: unknown) {
    await Promise.all(
      [...targets.values()].map(async ({ target }) => {
        try {
          await target.abort({ reason: error });
        } catch {
          // Preserve the first output-open error.
        }
      }),
    );
    throw error;
  }

  let closed = false;
  return {
    async write({ path, output }) {
      const state = targets.get(path);
      if (state === undefined)
        throw new Error(`sed: output file was not initialized: ${path}`);
      if (state.previousOutputMissingNewline) {
        await state.target.write({ text: encodeText({ text: recordTerminator }) });
      }
      await state.target.write({
        text: encodeText({
          text: output.hadNewline
            ? `${output.text}${recordTerminator}`
            : output.text,
        }),
      });
      state.previousOutputMissingNewline = !output.hadNewline;
    },
    async close() {
      if (closed) return;
      const failures: unknown[] = [];
      for (const { target } of targets.values()) {
        try {
          await target.close();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      closed = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "sed: failed to close output files");
      }
    },
    async abort({ reason }) {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...targets.values()].map(async ({ target }) => {
          try {
            await target.abort({ reason });
          } catch {
            // Preserve the original sed failure.
          }
        }),
      );
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
