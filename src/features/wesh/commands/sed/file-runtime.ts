import type { WeshCharacterLocaleMode } from "@/features/wesh/commands/_shared/locale";
import type {
  WeshCommandContext,
  WeshFileHandle,
} from "@/features/wesh/types";
import {
  openFileReadStream,
  openHandleReadStream,
} from "@/features/wesh/utils/fs";
import { canonicalizeExistingPath, normalizePath } from "@/features/wesh/path";
import { iterateReadableStreamChunks } from "@/features/wesh/utils/stream";
import { iterateByteRecordEntries } from "@/features/wesh/utils/text-records";
import {
  decodeSedDataBytes,
  toSedLocaleText,
} from "./locale-text";
import type {
  SedInputFileIssue,
  SedInputReadPhase,
  SedInputReadState,
  SedTextLine,
} from "./runtime-model";

export function resolveSedInPlaceRecoveryPath({
  cwd,
  file,
  fullPath,
  suffix,
}: {
  cwd: string;
  file: string;
  fullPath: string;
  suffix: string;
}): string {
  if (!suffix.includes("*")) return `${fullPath}${suffix}`;
  const expandedSuffix = suffix.replaceAll("*", file);
  return expandedSuffix.startsWith("/")
    ? expandedSuffix
    : `${cwd}/${expandedSuffix}`;
}

function openSedUnbufferedHandleReadStream({
  handle,
}: {
  handle: WeshFileHandle;
}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = new Uint8Array(1);
      try {
        const { bytesRead } = await handle.read({ buffer, length: 1 });
        if (bytesRead === 0) {
          await handle.close();
          controller.close();
          return;
        }
        controller.enqueue(buffer);
      } catch (error: unknown) {
        await handle.close();
        controller.error(error);
      }
    },
    async cancel() {
      await handle.close();
    },
  }, { highWaterMark: 0 });
}

export async function openSedInputStream({
  context,
  file,
  unbuffered,
}: {
  context: WeshCommandContext;
  file: string;
  unbuffered: boolean;
}): Promise<ReadableStream<Uint8Array>> {
  if (file === "-") {
    return unbuffered
      ? openSedUnbufferedHandleReadStream({ handle: context.stdin })
      : openHandleReadStream({ handle: context.stdin });
  }

  const path = file.startsWith("/") ? file : `${context.cwd}/${file}`;
  return openFileReadStream({
    files: context.files,
    path,
  });
}

export async function* readSedTextRecords({
  stream,
  sourceName,
  delimiterByte,
  characterLocaleMode,
}: {
  stream: ReadableStream<Uint8Array>;
  sourceName: string;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
}): AsyncGenerator<SedTextLine> {
  const localeSourceName = toSedLocaleText({ text: sourceName, characterLocaleMode });
  for await (const record of iterateByteRecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte,
  })) {
    yield {
      line: decodeSedDataBytes({
        bytes: record.bytes,
        characterLocaleMode,
      }),
      hadNewline: record.termination === "delimiter",
      sourceName: localeSourceName,
    };
  }
}

export function resolveSedCommandPath({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): string {
  return normalizePath({ cwd: context.cwd, path });
}

export async function isSedInputDirectory({
  context,
  file,
}: {
  context: WeshCommandContext;
  file: string;
}): Promise<boolean> {
  if (file === "-") return false;
  try {
    const lexicalPath = resolveSedCommandPath({ context, path: file });
    const stat = await context.files.stat({ path: lexicalPath });
    switch (stat.type) {
    case "directory":
      return true;
    case "file":
    case "fifo":
    case "chardev":
      return false;
    case "symlink": {
      const canonicalPath = await canonicalizeExistingPath({
        context,
        path: lexicalPath,
      });
      return (await context.files.stat({ path: canonicalPath })).type === "directory";
    }
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled sed input type: ${_ex}`);
    }
    }
  } catch {
    return false;
  }
}

export async function* readSedFiles({
  context,
  files,
  resolveFile,
  onError,
  inputReadState,
  delimiterByte,
  characterLocaleMode,
  unbuffered,
}: {
  context: WeshCommandContext;
  files: readonly string[];
  resolveFile?: ({ file }: { file: string }) => Promise<{ path: string; sourceName: string }>;
  onError: ({
    file,
    issue,
    phase,
  }: {
    file: string;
    issue: SedInputFileIssue;
    phase: SedInputReadPhase;
  }) => Promise<boolean>;
  inputReadState: SedInputReadState;
  delimiterByte: number;
  characterLocaleMode: WeshCharacterLocaleMode;
  unbuffered: boolean;
}): AsyncGenerator<SedTextLine> {
  for (const file of files) {
    let issue: SedInputFileIssue | undefined;
    try {
      const resolvedInput = resolveFile === undefined
        ? { path: file, sourceName: file }
        : await resolveFile({ file });
      if (await isSedInputDirectory({ context, file: resolvedInput.path })) {
        issue = { kind: "directory" };
      } else {
        const stream = await openSedInputStream({
          context,
          file: resolvedInput.path,
          unbuffered,
        });
        yield* readSedTextRecords({
          stream,
          sourceName: resolvedInput.sourceName,
          delimiterByte,
          characterLocaleMode,
        });
        continue;
      }
    } catch (error: unknown) {
      issue = { kind: "readError", error };
    }

    const shouldContinue = await onError({
      file,
      issue,
      phase: inputReadState.phase,
    });
    if (!shouldContinue) return;
  }
}

function resolveSedLexicalSymlinkTarget({
  path,
  target,
}: {
  path: string;
  target: string;
}): string {
  if (target.startsWith("/")) return target;
  const finalSlashIndex = path.lastIndexOf("/");
  return finalSlashIndex < 0
    ? target
    : `${path.slice(0, finalSlashIndex + 1)}${target}`;
}

export async function resolveSedFollowSymlinkInput({
  context,
  file,
  dashIsStdin,
  resolveSourceName,
}: {
  context: WeshCommandContext;
  file: string;
  dashIsStdin: boolean;
  resolveSourceName: boolean;
}): Promise<{ path: string; sourceName: string }> {
  if (dashIsStdin && file === "-") return { path: file, sourceName: file };

  const lexicalFullPath = file.startsWith("/") ? file : `${context.cwd}/${file}`;
  const path = await canonicalizeExistingPath({ context, path: lexicalFullPath });
  if (!resolveSourceName) return { path, sourceName: file };

  let sourceName = file;
  while (true) {
    const sourcePath = resolveSedCommandPath({ context, path: sourceName });
    const stat = await context.files.lstat({ path: sourcePath });
    switch (stat.type) {
    case "symlink":
      break;
    case "directory":
    case "file":
    case "fifo":
    case "chardev":
      return { path, sourceName };
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled sed follow-symlink input type: ${_ex}`);
    }
    }

    const target = await context.files.readlink({ path: sourcePath });
    if (target.length === 0) {
      throw new Error(`Invalid symbolic link target: ${sourcePath}`);
    }
    sourceName = resolveSedLexicalSymlinkTarget({ path: sourceName, target });
  }

  return { path, sourceName };
}

export async function createSedTemporaryFile({
  context,
  targetPath,
  mode,
}: {
  context: WeshCommandContext;
  targetPath: string;
  mode: number;
}): Promise<{
  path: string;
  handle: WeshFileHandle;
}> {
  const separatorIndex = targetPath.lastIndexOf("/");
  const parentPath =
    separatorIndex <= 0 ? "/" : targetPath.slice(0, separatorIndex);
  const basename = targetPath.slice(separatorIndex + 1);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = `.${basename}.sed-${context.pid}-${attempt}`;
    const temporaryPath =
      parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    try {
      const handle = await context.files.open({
        path: temporaryPath,
        flags: {
          access: "write",
          creation: "always",
          truncate: "truncate",
          append: "preserve",
        },
        mode,
      });
      return {
        path: temporaryPath,
        handle,
      };
    } catch (error: unknown) {
      if (attempt === 99) {
        throw error;
      }
    }
  }
  throw new Error(`Unable to create temporary file for ${targetPath}`);
}

export const TEST_ONLY = {
};
