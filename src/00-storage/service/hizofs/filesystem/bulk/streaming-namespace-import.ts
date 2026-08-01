import {
  UINT64_MAXIMUM,
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
  type InodeTimestamps,
} from "@/00-storage/service/hizofs/00-format";
import type { FileContentMutationPort } from "@/00-storage/service/hizofs/filesystem/file/file-content-mutation";
import {
  StreamingDirectoryImport,
  type StreamingDirectoryImportCheckpoint,
  type StreamingDirectoryImportLimits,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-directory-import";
import {
  StreamingFileImport,
  type StreamingFileImportCheckpoint,
  type StreamingFileImportLimits,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-file-import";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  applyRootInodeTableMutations,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";

export type StreamingNamespaceImportErrorCode =
  | "active_file_conflict"
  | "allocator_exhausted"
  | "already_finalized"
  | "import_failed"
  | "invalid_path"
  | "non_depth_first_path";

export class StreamingNamespaceImportError extends Error {
  readonly code: StreamingNamespaceImportErrorCode;

  constructor({ code, message }: { code: StreamingNamespaceImportErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "StreamingNamespaceImportError";
  }
}

export type StreamingNamespaceImportLimits = Readonly<{
  directory: StreamingDirectoryImportLimits;
  file: StreamingFileImportLimits;
}>;

export type StreamingNamespaceDirectoryCheckpoint = Readonly<{
  directory: StreamingDirectoryImportCheckpoint;
  path: readonly string[];
}>;

export type StreamingNamespaceFileCheckpoint = Readonly<{
  file: StreamingFileImportCheckpoint;
  inodeNumber: InodeNumber;
  path: readonly string[];
}>;

export type StreamingNamespaceImportCheckpoint = Readonly<{
  activeFile: StreamingNamespaceFileCheckpoint | undefined;
  directories: readonly StreamingNamespaceDirectoryCheckpoint[];
  nextInodeNumber: InodeNumber;
  rootDirectoryInodeNumber: InodeNumber;
  rootInodeTableRootHomeRef: HomeRecordReference;
}>;

export type SealedStreamingNamespaceImport = Readonly<{
  nextInodeNumber: InodeNumber;
  rootDirectoryInodeNumber: InodeNumber;
  rootInodeTableRootHomeRef: HomeRecordReference;
}>;

export type StreamingNamespaceImportPort = Readonly<{
  directoryPageStore: DirectoryPageTreePageStore;
  fileContentPort: FileContentMutationPort;
  rootInodeTablePageStore: RootInodeTablePageStore;
}>;

type DirectoryFrame = {
  directory: StreamingDirectoryImport;
  path: readonly string[];
};

type ActiveFile = {
  file: StreamingFileImport;
  inodeNumber: InodeNumber;
  path: readonly string[];
};

type StreamingNamespaceImportState = "active" | "failed" | "finalized";

function clonePath({ path }: { path: readonly string[] }): readonly string[] {
  return [...path];
}

function pathsEqual({ left, right }: { left: readonly string[]; right: readonly string[] }): boolean {
  return left.length === right.length && left.every((component, index) => component === right[index]);
}

function entryName({ path }: { path: readonly string[] }): string {
  const value = path.at(-1);
  if (value === undefined) {
    throw new StreamingNamespaceImportError({
      code: "invalid_path",
      message: "streaming namespace entry path must contain a filename component",
    });
  }
  return value;
}

/**
 * Builds one private namespace while retaining only the active traversal stack.
 *
 * The transition coordinator traverses directories depth-first but does not
 * emit an explicit directory-close event. A path leaving the current prefix is
 * therefore the only safe point to seal completed child directories. Inode and
 * page records may be appended throughout the import, but this capability never
 * publishes a File System Commit or Superblock.
 */
export class StreamingNamespaceImport {
  readonly #limits: StreamingNamespaceImportLimits;
  readonly #port: StreamingNamespaceImportPort;
  readonly #rootDirectoryInodeNumber: InodeNumber;
  #activeFile: ActiveFile | undefined;
  #directories: DirectoryFrame[];
  #nextInodeNumber: InodeNumber;
  #rootInodeTableRootHomeRef: HomeRecordReference;
  #state: StreamingNamespaceImportState = "active";

  constructor({ limits, nextInodeNumber, port, rootDirectory, rootInodeTableRootHomeRef }: {
    limits: StreamingNamespaceImportLimits;
    nextInodeNumber: InodeNumber;
    port: StreamingNamespaceImportPort;
    rootDirectory: Readonly<{
      inodeNumber: InodeNumber;
      timestamps: InodeTimestamps;
    }>;
    rootInodeTableRootHomeRef: HomeRecordReference;
  }) {
    if (nextInodeNumber <= rootDirectory.inodeNumber) {
      throw new StreamingNamespaceImportError({
        code: "invalid_path",
        message: "streaming namespace allocator must begin after the root directory Inode Number",
      });
    }
    this.#limits = limits;
    this.#nextInodeNumber = nextInodeNumber;
    this.#port = port;
    this.#rootDirectoryInodeNumber = rootDirectory.inodeNumber;
    this.#rootInodeTableRootHomeRef = rootInodeTableRootHomeRef;
    this.#directories = [{
      directory: new StreamingDirectoryImport({
        inodeNumber: rootDirectory.inodeNumber,
        inodeRevision: createInodeRevision({ value: 1n }),
        limits: limits.directory,
        pageStore: port.directoryPageStore,
        timestamps: rootDirectory.timestamps,
      }),
      path: [],
    }];
  }

  static restore({ checkpoint, limits, port }: {
    checkpoint: StreamingNamespaceImportCheckpoint;
    limits: StreamingNamespaceImportLimits;
    port: StreamingNamespaceImportPort;
  }): StreamingNamespaceImport {
    const root = checkpoint.directories[0];
    if (root === undefined || root.path.length !== 0) {
      throw new StreamingNamespaceImportError({
        code: "invalid_path",
        message: "streaming namespace checkpoint must begin with the root directory frame",
      });
    }
    const value = new StreamingNamespaceImport({
      limits,
      nextInodeNumber: checkpoint.nextInodeNumber,
      port,
      rootDirectory: {
        inodeNumber: checkpoint.rootDirectoryInodeNumber,
        timestamps: root.directory.timestamps,
      },
      rootInodeTableRootHomeRef: checkpoint.rootInodeTableRootHomeRef,
    });
    value.#directories = checkpoint.directories.map(frame => ({
      directory: StreamingDirectoryImport.restore({
        checkpoint: frame.directory,
        limits: limits.directory,
        pageStore: port.directoryPageStore,
      }),
      path: clonePath({ path: frame.path }),
    }));
    value.#activeFile = checkpoint.activeFile === undefined
      ? undefined
      : {
        file: StreamingFileImport.restore({
          checkpoint: checkpoint.activeFile.file,
          limits: limits.file,
          port: port.fileContentPort,
        }),
        inodeNumber: createInodeNumber({ value: checkpoint.activeFile.inodeNumber }),
        path: clonePath({ path: checkpoint.activeFile.path }),
      };
    value.#state = "active";
    value.#validateRestoredStack();
    return value;
  }

  #validateRestoredStack(): void {
    if (this.#directories.length === 0 || this.#directories[0]?.path.length !== 0) {
      throw new StreamingNamespaceImportError({
        code: "invalid_path",
        message: "streaming namespace checkpoint lost its root directory frame",
      });
    }
    for (let index = 1; index < this.#directories.length; index += 1) {
      const parent = this.#directories[index - 1]?.path;
      const child = this.#directories[index]?.path;
      if (parent === undefined || child === undefined
        || child.length !== parent.length + 1
        || !parent.every((component, componentIndex) => component === child[componentIndex])) {
        throw new StreamingNamespaceImportError({
          code: "non_depth_first_path",
          message: "streaming namespace checkpoint directory frames are not one depth-first path",
        });
      }
    }
    const activeFileParent = this.#activeFile?.path.slice(0, -1);
    const currentDirectory = this.#directories.at(-1)?.path;
    if (activeFileParent !== undefined
      && (currentDirectory === undefined || !pathsEqual({ left: activeFileParent, right: currentDirectory }))) {
      throw new StreamingNamespaceImportError({
        code: "non_depth_first_path",
        message: "streaming namespace checkpoint active file is not owned by the current directory",
      });
    }
  }

  #assertActive(): void {
    switch (this.#state) {
    case "active": return;
    case "failed": throw new StreamingNamespaceImportError({
      code: "import_failed",
      message: "streaming namespace import failed and cannot be reused",
    });
    case "finalized": throw new StreamingNamespaceImportError({
      code: "already_finalized",
      message: "streaming namespace import was already finalized",
    });
    default: return this.#state satisfies never;
    }
  }

  #allocateInodeNumber(): InodeNumber {
    if (this.#nextInodeNumber === UINT64_MAXIMUM) {
      throw new StreamingNamespaceImportError({
        code: "allocator_exhausted",
        message: "streaming namespace Inode Number allocator is exhausted",
      });
    }
    const value = this.#nextInodeNumber;
    this.#nextInodeNumber = createInodeNumber({ value: value + 1n });
    return value;
  }

  async #storeInode({ entry }: { entry: InodeLeafEntry }): Promise<void> {
    this.#rootInodeTableRootHomeRef = await applyRootInodeTableMutations({
      changes: [{ entry, type: "set" }],
      pageStore: this.#port.rootInodeTablePageStore,
      rootReference: this.#rootInodeTableRootHomeRef,
    });
  }

  async #closeCurrentDirectory(): Promise<void> {
    const frame = this.#directories.pop();
    if (frame === undefined) {
      throw new StreamingNamespaceImportError({
        code: "invalid_path",
        message: "streaming namespace directory stack is empty",
      });
    }
    await this.#storeInode({ entry: await frame.directory.finalize() });
  }

  async #prepareParent({ path }: { path: readonly string[] }): Promise<DirectoryFrame> {
    if (this.#activeFile !== undefined) {
      throw new StreamingNamespaceImportError({
        code: "active_file_conflict",
        message: "streaming namespace cannot leave an unfinished file",
      });
    }
    entryName({ path });
    const parentPath = path.slice(0, -1);
    while ((this.#directories.at(-1)?.path.length ?? -1) > parentPath.length) {
      await this.#closeCurrentDirectory();
    }
    const parent = this.#directories.at(-1);
    if (parent === undefined || !pathsEqual({ left: parent.path, right: parentPath })) {
      throw new StreamingNamespaceImportError({
        code: "non_depth_first_path",
        message: "streaming namespace target path does not follow the active depth-first directory stack",
      });
    }
    return parent;
  }

  async #addParentEntry({ inodeKind, inodeNumber, path }: {
    inodeKind: "directory" | "file" | "symlink";
    inodeNumber: InodeNumber;
    path: readonly string[];
  }): Promise<void> {
    const parent = await this.#prepareParent({ path });
    await parent.directory.addEntry({ entry: {
      inodeKind,
      inodeNumber,
      name: entryName({ path }),
      targetType: "inode",
    } });
  }

  async ensureDirectory({ path, timestamps }: {
    path: readonly string[];
    timestamps: InodeTimestamps;
  }): Promise<void> {
    this.#assertActive();
    try {
      const inodeNumber = this.#allocateInodeNumber();
      await this.#addParentEntry({ inodeKind: "directory", inodeNumber, path });
      this.#directories.push({
        directory: new StreamingDirectoryImport({
          inodeNumber,
          inodeRevision: createInodeRevision({ value: 1n }),
          limits: this.#limits.directory,
          pageStore: this.#port.directoryPageStore,
          timestamps,
        }),
        path: clonePath({ path }),
      });
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async writeFileChunk({ bytes, offset, path }: {
    bytes: Uint8Array;
    offset: bigint;
    path: readonly string[];
  }): Promise<void> {
    this.#assertActive();
    try {
      if (this.#activeFile === undefined) {
        const inodeNumber = this.#allocateInodeNumber();
        await this.#addParentEntry({ inodeKind: "file", inodeNumber, path });
        this.#activeFile = {
          file: new StreamingFileImport({
            limits: this.#limits.file,
            port: this.#port.fileContentPort,
          }),
          inodeNumber,
          path: clonePath({ path }),
        };
      } else if (!pathsEqual({ left: this.#activeFile.path, right: path })) {
        throw new StreamingNamespaceImportError({
          code: "active_file_conflict",
          message: "streaming namespace file chunks changed path before finalization",
        });
      }
      await this.#activeFile.file.writeChunk({ bytes, offset });
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async finalizeFile({ path, size, timestamps }: {
    path: readonly string[];
    size: bigint;
    timestamps: InodeTimestamps;
  }): Promise<void> {
    this.#assertActive();
    try {
      if (this.#activeFile === undefined) {
        const inodeNumber = this.#allocateInodeNumber();
        await this.#addParentEntry({ inodeKind: "file", inodeNumber, path });
        this.#activeFile = {
          file: new StreamingFileImport({
            limits: this.#limits.file,
            port: this.#port.fileContentPort,
          }),
          inodeNumber,
          path: clonePath({ path }),
        };
      }
      if (!pathsEqual({ left: this.#activeFile.path, right: path })) {
        throw new StreamingNamespaceImportError({
          code: "active_file_conflict",
          message: "streaming namespace finalized a different file from the active chunk stream",
        });
      }
      const activeFile = this.#activeFile;
      const content = await activeFile.file.finalize({ size });
      await this.#storeInode({ entry: {
        content,
        fileSize: createFileOffset({ value: size }),
        inodeKind: "file",
        inodeNumber: activeFile.inodeNumber,
        inodeRevision: createInodeRevision({ value: 1n }),
        timestamps: { ...timestamps },
      } });
      this.#activeFile = undefined;
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async writeSymlink({ path, target, timestamps }: {
    path: readonly string[];
    target: string;
    timestamps: InodeTimestamps;
  }): Promise<void> {
    this.#assertActive();
    try {
      const inodeNumber = this.#allocateInodeNumber();
      await this.#addParentEntry({ inodeKind: "symlink", inodeNumber, path });
      await this.#storeInode({ entry: {
        inodeKind: "symlink",
        inodeNumber,
        inodeRevision: createInodeRevision({ value: 1n }),
        target,
        timestamps: { ...timestamps },
      } });
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async checkpoint(): Promise<StreamingNamespaceImportCheckpoint> {
    this.#assertActive();
    try {
      return {
        activeFile: this.#activeFile === undefined
          ? undefined
          : {
            file: this.#activeFile.file.checkpoint(),
            inodeNumber: this.#activeFile.inodeNumber,
            path: clonePath({ path: this.#activeFile.path }),
          },
        directories: await (async () => {
          const checkpoints: StreamingNamespaceDirectoryCheckpoint[] = [];
          for (const frame of this.#directories) {
            checkpoints.push({
              directory: await frame.directory.checkpoint(),
              path: clonePath({ path: frame.path }),
            });
          }
          return checkpoints;
        })(),
        nextInodeNumber: this.#nextInodeNumber,
        rootDirectoryInodeNumber: this.#rootDirectoryInodeNumber,
        rootInodeTableRootHomeRef: this.#rootInodeTableRootHomeRef,
      };
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  async finalize(): Promise<SealedStreamingNamespaceImport> {
    this.#assertActive();
    if (this.#activeFile !== undefined) {
      this.#state = "failed";
      throw new StreamingNamespaceImportError({
        code: "active_file_conflict",
        message: "streaming namespace cannot finalize with an unfinished file",
      });
    }
    try {
      while (this.#directories.length > 0) await this.#closeCurrentDirectory();
      this.#state = "finalized";
      return {
        nextInodeNumber: this.#nextInodeNumber,
        rootDirectoryInodeNumber: this.#rootDirectoryInodeNumber,
        rootInodeTableRootHomeRef: this.#rootInodeTableRootHomeRef,
      };
    } catch (cause: unknown) {
      this.#state = "failed";
      throw cause;
    }
  }

  state(): StreamingNamespaceImportState {
    return this.#state;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  pathsEqual,
};
