import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext } from "@/features/wesh/types";

interface SedReadFileLine {
  line: string;
  hadNewline: boolean;
  sourceName: string;
}

interface SedReadFileWriter {
  terminatePendingOutput(): Promise<void>;
  writeReadFile({
    lines,
    terminatePendingOutputWhenEmpty,
  }: {
    lines: AsyncIterable<SedReadFileLine> | undefined;
    terminatePendingOutputWhenEmpty: boolean;
  }): Promise<void>;
}

export type SedReadFileTermination = { kind: "fatal"; exitCode: 4 };

export interface SedPreparedReadFileLine {
  readonly kind: "preparedReadFileLine";
  readonly path: string;
}

export interface SedReadFileManager {
  prepareLine({
    path,
  }: {
    path: string;
  }): Promise<SedPreparedReadFileLine | SedReadFileTermination>;
  writeAll({
    path,
    writer,
  }: {
    path: string;
    writer: SedReadFileWriter;
  }): Promise<SedReadFileTermination | undefined>;
  writeLine({
    prepared,
    writer,
  }: {
    prepared: SedPreparedReadFileLine;
    writer: SedReadFileWriter;
  }): Promise<void>;
  close(): Promise<void>;
}

export function createSedReadFileManager({
  context,
  openLines,
}: {
  context: WeshCommandContext;
  openLines: ({ path }: { path: string }) => Promise<AsyncIterable<SedReadFileLine>>;
}): SedReadFileManager {
  // GNU sed keeps each `R` stream cursor by the file operand spelling in the
  // script, not by canonical file identity. Preserve the raw path as the key:
  // `aux`, `./aux`, and a symlink alias to `aux` intentionally have separate
  // cursors even when they resolve to the same underlying file.
  const lineIterators = new Map<
    string,
    AsyncIterator<SedReadFileLine> | undefined
  >();

  const validate = async ({
    path,
  }: {
    path: string;
  }): Promise<SedReadFileTermination | undefined> => {
    let stat: Awaited<ReturnType<WeshCommandContext["files"]["stat"]>>;
    try {
      stat = await context.files.stat({
        path: normalizePath({ cwd: context.cwd, path }),
      });
    } catch {
      return undefined;
    }

    switch (stat.type) {
    case "directory":
      await context.text().error({
        text: `sed: read error on ${path}: Is a directory\n`,
      });
      return { kind: "fatal", exitCode: 4 };
    case "file":
    case "fifo":
    case "chardev":
    case "symlink":
      return undefined;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled sed read-file target type: ${_ex}`);
    }
    }
  };

  const openLinesSafely = async ({
    path,
  }: {
    path: string;
  }): Promise<AsyncIterable<SedReadFileLine> | undefined> => {
    try {
      return await openLines({ path });
    } catch {
      return undefined;
    }
  };

  return {
    async prepareLine({ path }) {
      const termination = await validate({ path });
      if (termination !== undefined) return termination;
      return { kind: "preparedReadFileLine", path };
    },
    async writeAll({ path, writer }) {
      const termination = await validate({ path });
      if (termination !== undefined) {
        await writer.terminatePendingOutput();
        return termination;
      }
      await writer.writeReadFile({
        lines: await openLinesSafely({ path }),
        terminatePendingOutputWhenEmpty: true,
      });
      return undefined;
    },
    async writeLine({ prepared, writer }) {
      const { path } = prepared;
      if (!lineIterators.has(path)) {
        const lines = await openLinesSafely({ path });
        lineIterators.set(path, lines?.[Symbol.asyncIterator]());
      }
      const iterator = lineIterators.get(path);
      const result = iterator === undefined ? undefined : await iterator.next();
      const line = result?.done === false ? result.value : undefined;
      await writer.writeReadFile({
        lines:
          line === undefined
            ? undefined
            : (async function* (): AsyncGenerator<SedReadFileLine> {
              yield line;
            })(),
        terminatePendingOutputWhenEmpty: false,
      });
    },
    async close() {
      const failures: unknown[] = [];
      for (const iterator of lineIterators.values()) {
        try {
          await iterator?.return?.();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      lineIterators.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "sed: failed to close read files");
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
