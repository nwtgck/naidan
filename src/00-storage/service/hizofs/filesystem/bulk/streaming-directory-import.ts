import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  encodeDirectoryEntry,
  encodeFilenameComponent,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type InodeNumber,
  type InodeRevision,
  type InodeTimestamps,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  applyDirectoryPageTreeMutations,
  type DirectoryPageTreeMutation,
  type DirectoryPageTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";

export type StreamingDirectoryImportErrorCode =
  | "already_finalized"
  | "import_failed"
  | "invalid_limits"
  | "non_canonical_entry_order";

export class StreamingDirectoryImportError extends Error {
  readonly code: StreamingDirectoryImportErrorCode;

  constructor({ code, message }: { code: StreamingDirectoryImportErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "StreamingDirectoryImportError";
  }
}

export type StreamingDirectoryImportLimits = Readonly<{
  maximumEntryMutationsPerBatch: number;
}>;

export type StreamingDirectoryImportCheckpoint = Readonly<{
  content:
    | Readonly<{ entries: readonly DirectoryLeafEntry[]; type: "inline" }>
    | Readonly<{ directoryTreeRootHomeRef: HomeRecordReference; type: "tree" }>;
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  previousName: string | undefined;
  timestamps: InodeTimestamps;
}>;

type StreamingDirectoryImportState = "active" | "failed" | "finalized";

function cloneDirectoryEntry({ entry }: { entry: DirectoryLeafEntry }): DirectoryLeafEntry {
  return { ...entry };
}

function requireEntryMutationBatchLimit({ limits }: { limits: StreamingDirectoryImportLimits }): number {
  const value = limits.maximumEntryMutationsPerBatch;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StreamingDirectoryImportError({
      code: "invalid_limits",
      message: "streaming directory import mutation batch size must be a positive safe integer",
    });
  }
  return value;
}

/**
 * Accumulates one unpublished directory with bounded memory.
 *
 * Small directories remain inline and allocate no Directory Page records.
 * Once the inline encoding bound is crossed, entries are flushed into an
 * immutable private Directory Page tree in bounded mutation batches. The
 * caller receives only a completed inode entry; this class never publishes a
 * File System Commit or Superblock.
 */
export class StreamingDirectoryImport {
  readonly #inodeNumber: InodeNumber;
  readonly #inodeRevision: InodeRevision;
  readonly #mutationBatchLimit: number;
  readonly #pageStore: DirectoryPageTreePageStore;
  readonly #timestamps: InodeTimestamps;
  #inlineEncodedBytes = 0;
  #inlineEntries: DirectoryLeafEntry[] = [];
  #pendingTreeMutations: DirectoryPageTreeMutation[] = [];
  #previousName: string | undefined;
  #previousNameBytes: Uint8Array | undefined;
  #state: StreamingDirectoryImportState = "active";
  #treeRoot: HomeRecordReference | undefined;

  constructor({ inodeNumber, inodeRevision, limits, pageStore, timestamps }: {
    inodeNumber: InodeNumber;
    inodeRevision: InodeRevision;
    limits: StreamingDirectoryImportLimits;
    pageStore: DirectoryPageTreePageStore;
    timestamps: InodeTimestamps;
  }) {
    this.#inodeNumber = inodeNumber;
    this.#inodeRevision = inodeRevision;
    this.#mutationBatchLimit = requireEntryMutationBatchLimit({ limits });
    this.#pageStore = pageStore;
    this.#timestamps = { ...timestamps };
  }

  static restore({ checkpoint, limits, pageStore }: {
    checkpoint: StreamingDirectoryImportCheckpoint;
    limits: StreamingDirectoryImportLimits;
    pageStore: DirectoryPageTreePageStore;
  }): StreamingDirectoryImport {
    const value = new StreamingDirectoryImport({
      inodeNumber: checkpoint.inodeNumber,
      inodeRevision: checkpoint.inodeRevision,
      limits,
      pageStore,
      timestamps: checkpoint.timestamps,
    });
    switch (checkpoint.content.type) {
    case "inline": {
      value.#inlineEntries = checkpoint.content.entries.map(entry => cloneDirectoryEntry({ entry }));
      value.#inlineEncodedBytes = value.#inlineEntries.reduce(
        (total, entry) => total + encodeDirectoryEntry({ entry }).byteLength,
        0,
      );
      break;
    }
    case "tree": value.#treeRoot = checkpoint.content.directoryTreeRootHomeRef; break;
    default: checkpoint.content satisfies never;
    }
    value.#previousNameBytes = checkpoint.previousName === undefined
      ? undefined
      : encodeFilenameComponent({ value: checkpoint.previousName });
    value.#previousName = checkpoint.previousName;
    return value;
  }

  #assertActive(): void {
    switch (this.#state) {
    case "active": return;
    case "failed": throw new StreamingDirectoryImportError({
      code: "import_failed",
      message: "streaming directory import failed and cannot be reused",
    });
    case "finalized": throw new StreamingDirectoryImportError({
      code: "already_finalized",
      message: "streaming directory import was already finalized",
    });
    default: return this.#state satisfies never;
    }
  }

  async #ensureTreeRoot(): Promise<HomeRecordReference> {
    if (this.#treeRoot !== undefined) return this.#treeRoot;
    this.#treeRoot = await this.#pageStore.writePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    return this.#treeRoot;
  }

  async #flushTreeMutations(): Promise<void> {
    if (this.#pendingTreeMutations.length === 0) return;
    this.#treeRoot = await applyDirectoryPageTreeMutations({
      changes: this.#pendingTreeMutations,
      pageStore: this.#pageStore,
      rootReference: await this.#ensureTreeRoot(),
    });
    this.#pendingTreeMutations = [];
  }

  async #appendTreeEntry({ entry }: { entry: DirectoryLeafEntry }): Promise<void> {
    this.#pendingTreeMutations.push({ entry: cloneDirectoryEntry({ entry }), type: "set" });
    if (this.#pendingTreeMutations.length >= this.#mutationBatchLimit) {
      await this.#flushTreeMutations();
    }
  }

  async addEntry({ entry }: { entry: DirectoryLeafEntry }): Promise<void> {
    this.#assertActive();
    try {
      const nameBytes = encodeFilenameComponent({ value: entry.name });
      if (this.#previousNameBytes !== undefined
        && compareUnsignedBytes({ left: this.#previousNameBytes, right: nameBytes }) >= 0) {
        throw new StreamingDirectoryImportError({
          code: "non_canonical_entry_order",
          message: "streaming directory entries must be strictly ascending by canonical filename bytes",
        });
      }
      this.#previousNameBytes = nameBytes;
      this.#previousName = entry.name;
      const ownedEntry = cloneDirectoryEntry({ entry });
      const encodedLength = encodeDirectoryEntry({ entry: ownedEntry }).byteLength;

      if (this.#treeRoot === undefined
        && this.#inlineEncodedBytes + encodedLength <= HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineDirectoryEncodedBytes) {
        this.#inlineEntries.push(ownedEntry);
        this.#inlineEncodedBytes += encodedLength;
        return;
      }

      if (this.#treeRoot === undefined) {
        await this.#ensureTreeRoot();
        for (const inlineEntry of this.#inlineEntries) {
          await this.#appendTreeEntry({ entry: inlineEntry });
        }
        this.#inlineEntries = [];
        this.#inlineEncodedBytes = 0;
      }
      await this.#appendTreeEntry({ entry: ownedEntry });
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async finalize(): Promise<DirectoryInodeEntry> {
    this.#assertActive();
    try {
      if (this.#treeRoot !== undefined) await this.#flushTreeMutations();
      this.#state = "finalized";
      return {
        content: this.#treeRoot === undefined
          ? { entries: this.#inlineEntries.map(entry => cloneDirectoryEntry({ entry })), type: "inline" }
          : { directoryTreeRootHomeRef: this.#treeRoot, type: "tree" },
        inodeKind: "directory",
        inodeNumber: this.#inodeNumber,
        inodeRevision: this.#inodeRevision,
        timestamps: { ...this.#timestamps },
      };
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async checkpoint(): Promise<StreamingDirectoryImportCheckpoint> {
    this.#assertActive();
    try {
      if (this.#treeRoot !== undefined) await this.#flushTreeMutations();
      return {
        content: this.#treeRoot === undefined
          ? { entries: this.#inlineEntries.map(entry => cloneDirectoryEntry({ entry })), type: "inline" }
          : { directoryTreeRootHomeRef: this.#treeRoot, type: "tree" },
        inodeNumber: this.#inodeNumber,
        inodeRevision: this.#inodeRevision,
        previousName: this.#previousName,
        timestamps: { ...this.#timestamps },
      };
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  state(): StreamingDirectoryImportState {
    return this.#state;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
