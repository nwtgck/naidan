import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  type FileInodeEntry,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileContentMutationPort } from "@/00-storage/service/hizofs/filesystem/file/file-content-mutation";
import {
  applyFileExtentTreeMutations,
  type FileExtentTreeMutation,
} from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";

export type StreamingFileImportErrorCode =
  | "already_finalized"
  | "import_failed"
  | "invalid_limits"
  | "non_sequential_chunk"
  | "size_mismatch"
  | "zero_length_chunk";

export class StreamingFileImportError extends Error {
  readonly code: StreamingFileImportErrorCode;

  constructor({ code, message }: { code: StreamingFileImportErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "StreamingFileImportError";
  }
}

export type StreamingFileImportLimits = Readonly<{
  maximumExtentMutationsPerBatch: number;
}>;

export type StreamingFileImportCheckpoint = Readonly<{
  extentRoot: HomeRecordReference | undefined;
  nextOffset: bigint;
}>;

type StreamingFileImportState = "active" | "failed" | "finalized";

function requireMutationBatchLimit({ limits }: { limits: StreamingFileImportLimits }): number {
  const value = limits.maximumExtentMutationsPerBatch;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StreamingFileImportError({
      code: "invalid_limits",
      message: "streaming file import extent mutation batch size must be a positive safe integer",
    });
  }
  return value;
}

function firstNonZeroByte({ bytes, start }: { bytes: Uint8Array; start: number }): number | undefined {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) return index;
  }
  return undefined;
}

function firstZeroByte({ bytes, start }: { bytes: Uint8Array; start: number }): number {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) return index;
  }
  return bytes.byteLength;
}

/**
 * Builds one unpublished extent-backed file from bounded sequential chunks.
 *
 * File Data and File Extent Page records may be appended during import, but
 * this capability never publishes a File System Commit or Superblock. Zero
 * ranges remain implicit sparse holes, so a large logical file does not force
 * either complete-file buffering or zero-filled physical allocation.
 */
export class StreamingFileImport {
  readonly #extentMutationBatchLimit: number;
  readonly #port: FileContentMutationPort;
  #extentRoot: HomeRecordReference | undefined;
  #nextOffset = 0n;
  #state: StreamingFileImportState = "active";

  constructor({ limits, port }: {
    limits: StreamingFileImportLimits;
    port: FileContentMutationPort;
  }) {
    this.#extentMutationBatchLimit = requireMutationBatchLimit({ limits });
    this.#port = port;
  }

  static restore({ checkpoint, limits, port }: {
    checkpoint: StreamingFileImportCheckpoint;
    limits: StreamingFileImportLimits;
    port: FileContentMutationPort;
  }): StreamingFileImport {
    const value = new StreamingFileImport({ limits, port });
    value.#extentRoot = checkpoint.extentRoot;
    value.#nextOffset = createFileOffset({ value: checkpoint.nextOffset });
    return value;
  }

  #assertActive(): void {
    switch (this.#state) {
    case "active": return;
    case "failed": throw new StreamingFileImportError({
      code: "import_failed",
      message: "streaming file import failed and cannot be reused",
    });
    case "finalized": throw new StreamingFileImportError({
      code: "already_finalized",
      message: "streaming file import was already finalized",
    });
    default: return this.#state satisfies never;
    }
  }

  async #ensureExtentRoot(): Promise<HomeRecordReference> {
    if (this.#extentRoot !== undefined) return this.#extentRoot;
    this.#extentRoot = await this.#port.extentPageStore.writePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    return this.#extentRoot;
  }

  async #appendNonZeroRun({ bytes, fileOffset }: {
    bytes: Uint8Array;
    fileOffset: bigint;
  }): Promise<void> {
    let rootReference = await this.#ensureExtentRoot();
    const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
    let changes: FileExtentTreeMutation[] = [];

    const flush = async (): Promise<void> => {
      if (changes.length === 0) return;
      rootReference = await applyFileExtentTreeMutations({
        changes,
        pageStore: this.#port.extentPageStore,
        rootReference,
      });
      changes = [];
    };

    for (let offset = 0; offset < bytes.byteLength; offset += maximumPayload) {
      const chunk = new Uint8Array(bytes.subarray(offset, Math.min(offset + maximumPayload, bytes.byteLength)));
      const fileDataHomeRef = await this.#port.writeFileData({ bytes: chunk });
      changes.push({
        entry: {
          byteLength: chunk.byteLength,
          dataOffset: 0,
          fileDataHomeRef,
          fileOffset: createFileOffset({ value: fileOffset + BigInt(offset) }),
        },
        type: "set",
      });
      if (changes.length >= this.#extentMutationBatchLimit) await flush();
    }
    await flush();
    this.#extentRoot = rootReference;
  }

  async writeChunk({ bytes, offset }: {
    bytes: Uint8Array;
    offset: bigint;
  }): Promise<void> {
    this.#assertActive();
    if (bytes.byteLength === 0) {
      throw new StreamingFileImportError({
        code: "zero_length_chunk",
        message: "streaming file import chunk must contain at least one byte",
      });
    }
    if (offset !== this.#nextOffset) {
      throw new StreamingFileImportError({
        code: "non_sequential_chunk",
        message: "streaming file import chunks must cover the logical file sequentially",
      });
    }

    try {
      let searchOffset = 0;
      while (searchOffset < bytes.byteLength) {
        const runStart = firstNonZeroByte({ bytes, start: searchOffset });
        if (runStart === undefined) break;
        const runEnd = firstZeroByte({ bytes, start: runStart });
        await this.#appendNonZeroRun({
          bytes: bytes.subarray(runStart, runEnd),
          fileOffset: offset + BigInt(runStart),
        });
        searchOffset = runEnd;
      }
      this.#nextOffset += BigInt(bytes.byteLength);
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async finalize({ size }: { size: bigint }): Promise<FileInodeEntry["content"]> {
    this.#assertActive();
    if (size !== this.#nextOffset) {
      this.#state = "failed";
      throw new StreamingFileImportError({
        code: "size_mismatch",
        message: "streaming file import logical size does not match the consumed chunk range",
      });
    }
    this.#state = "finalized";
    if (size === 0n) return { bytes: new Uint8Array(), type: "inline" };
    return {
      extentTreeRootHomeRef: await this.#ensureExtentRoot(),
      type: "tree",
    };
  }

  checkpoint(): StreamingFileImportCheckpoint {
    this.#assertActive();
    return {
      extentRoot: this.#extentRoot,
      nextOffset: this.#nextOffset,
    };
  }

  state(): StreamingFileImportState {
    return this.#state;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  firstNonZeroByte,
  firstZeroByte,
};
