import {
  StreamingZipReader,
  createBlobZipSource,
  createWebZipCompressionCodec,
  type ZipArchiveEntry,
  type ZipRandomAccessSource,
} from "@/utils/zip-stream";

const ZIP_ARCHIVE_MAX_ENTRY_COUNT = 100_000;
const ZIP_ARCHIVE_MAX_PATH_DEPTH = 256;
const ZIP_ARCHIVE_MAX_INDEXED_NODE_COUNT = 100_000;
const ZIP_ARCHIVE_MAX_INDEXED_PATH_CHARACTERS = 16 * 1024 * 1024;
let nextZipArchiveViewIdentity = 1;

type ZipArchiveSourceFactory = () => Promise<ZipRandomAccessSource>;

export interface ZipArchiveViewChild {
  readonly name: string,
  readonly relativePath: string,
  readonly kind: "file" | "directory",
  readonly size: number | undefined,
  readonly lastModified: number | undefined,
}

interface IndexedZipFile {
  readonly archiveEntry: ZipArchiveEntry,
  readonly relativePath: string,
}

interface ZipArchiveIndexBudget {
  nodeCount: number,
  pathCharacters: number,
}

function reserveIndexPathCharacters({ path, budget }: { path: string, budget: ZipArchiveIndexBudget }): void {
  if (path.length > ZIP_ARCHIVE_MAX_INDEXED_PATH_CHARACTERS - budget.pathCharacters) {
    throw new Error("ZIP paths are too large to index safely");
  }
  budget.pathCharacters += path.length;
}

function reserveIndexedNode({ path, budget }: { path: string, budget: ZipArchiveIndexBudget }): void {
  if (budget.nodeCount >= ZIP_ARCHIVE_MAX_INDEXED_NODE_COUNT) {
    throw new Error("ZIP contains too many files and directories to index safely");
  }
  reserveIndexPathCharacters({ path, budget });
  budget.nodeCount += 1;
}

function hasZipMagic({ bytes }: { bytes: Uint8Array }): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  return bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (
      (bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08)
    );
}

async function blobHasZipMagic({ blob }: { blob: Blob }): Promise<boolean> {
  if (blob.size < 4) {
    return false;
  }
  return hasZipMagic({ bytes: new Uint8Array(await blob.slice(0, 4).arrayBuffer()) });
}

function normalizeArchiveEntryPath({
  name,
  isDirectory,
}: {
  name: string,
  isDirectory: boolean,
}): string | undefined {
  if (name.includes("\0")) {
    throw new Error("ZIP entry name contains a NUL character");
  }
  const withForwardSlashes = name.replaceAll("\\", "/");
  if (
    withForwardSlashes.startsWith("/")
    || withForwardSlashes.startsWith("//")
    || /^[A-Za-z]:\//u.test(withForwardSlashes)
  ) {
    throw new Error(`ZIP entry uses an absolute path: ${name}`);
  }
  const segments = withForwardSlashes
    .split("/")
    .filter(segment => segment.length > 0 && segment !== ".");
  if (segments.some(segment => segment === "..")) {
    throw new Error(`ZIP entry escapes the archive root: ${name}`);
  }
  if (segments.length > ZIP_ARCHIVE_MAX_PATH_DEPTH) {
    throw new Error(`ZIP entry path is too deep: ${name}`);
  }
  if (segments.length === 0) {
    if (isDirectory) {
      return undefined;
    }
    throw new Error(`ZIP file entry has an empty path: ${name}`);
  }
  return segments.join("/");
}

function getParentRelativePath({ relativePath }: { relativePath: string }): string {
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex < 0 ? "" : relativePath.slice(0, slashIndex);
}

function getBaseName({ relativePath }: { relativePath: string }): string {
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex < 0 ? relativePath : relativePath.slice(slashIndex + 1);
}

function addDirectoryAndParents({
  relativePath,
  directoryPaths,
  budget,
}: {
  relativePath: string,
  directoryPaths: Set<string>,
  budget: ZipArchiveIndexBudget,
}): void {
  if (relativePath === "") {
    directoryPaths.add("");
    return;
  }
  const segments = relativePath.split("/");
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    if (!directoryPaths.has(current)) {
      reserveIndexedNode({ path: current, budget });
      directoryPaths.add(current);
    }
  }
}

export class ZipArchiveView {
  readonly cacheIdentity = nextZipArchiveViewIdentity++;
  private readonly createSource: ZipArchiveSourceFactory;
  private readonly filesByPath: ReadonlyMap<string, IndexedZipFile>;
  private readonly directoryPaths: ReadonlySet<string>;
  private readonly childrenByDirectory: ReadonlyMap<string, readonly ZipArchiveViewChild[]>;

  private constructor({
    createSource,
    filesByPath,
    directoryPaths,
    childrenByDirectory,
  }: {
    createSource: ZipArchiveSourceFactory,
    filesByPath: ReadonlyMap<string, IndexedZipFile>,
    directoryPaths: ReadonlySet<string>,
    childrenByDirectory: ReadonlyMap<string, readonly ZipArchiveViewChild[]>,
  }) {
    this.createSource = createSource;
    this.filesByPath = filesByPath;
    this.directoryPaths = directoryPaths;
    this.childrenByDirectory = childrenByDirectory;
  }

  static async blobHasZipMagic({ blob }: { blob: Blob }): Promise<boolean> {
    return blobHasZipMagic({ blob });
  }

  static async sourceHasZipMagic({
    createSource,
  }: {
    createSource: ZipArchiveSourceFactory,
  }): Promise<boolean> {
    const source = await createSource();
    try {
      if (source.size < 4) {
        return false;
      }
      return hasZipMagic({ bytes: await source.read({ offset: 0, length: 4 }) });
    } finally {
      await source.close();
    }
  }

  static async openIfZipSource({
    createSource,
  }: {
    createSource: ZipArchiveSourceFactory,
  }): Promise<ZipArchiveView | undefined> {
    if (!await ZipArchiveView.sourceHasZipMagic({ createSource })) {
      return undefined;
    }
    return ZipArchiveView.openSource({ createSource });
  }

  static async openIfZip({ blob }: { blob: Blob }): Promise<ZipArchiveView | undefined> {
    if (!await ZipArchiveView.blobHasZipMagic({ blob })) {
      return undefined;
    }
    return ZipArchiveView.open({ blob });
  }

  static async open({ blob }: { blob: Blob }): Promise<ZipArchiveView> {
    return ZipArchiveView.openSource({
      createSource: async () => createBlobZipSource({ blob }),
    });
  }

  static async openSource({
    createSource,
  }: {
    createSource: ZipArchiveSourceFactory,
  }): Promise<ZipArchiveView> {
    const source = await createSource();
    const reader = new StreamingZipReader({
      source,
      compressionCodec: createWebZipCompressionCodec(),
    });
    const filesByPath = new Map<string, IndexedZipFile>();
    const explicitDirectoryEntries = new Map<string, ZipArchiveEntry>();
    const directoryPaths = new Set<string>([""]);
    const seenPaths = new Set<string>();
    // Count implicit parents as well as entries, and bound retained path text.
    const budget: ZipArchiveIndexBudget = { nodeCount: 0, pathCharacters: 0 };
    let entryCount = 0;

    try {
      for await (const archiveEntry of reader.entries()) {
        entryCount += 1;
        if (entryCount > ZIP_ARCHIVE_MAX_ENTRY_COUNT) {
          throw new Error("ZIP contains too many entries");
        }
        const relativePath = normalizeArchiveEntryPath({
          name: archiveEntry.name,
          isDirectory: archiveEntry.isDirectory,
        });
        if (relativePath === undefined) {
          continue;
        }

        // The original name remains in entry metadata even after normalization.
        reserveIndexPathCharacters({ path: archiveEntry.name, budget });

        if (seenPaths.has(relativePath)) {
          throw new Error(`ZIP contains a duplicate path: ${relativePath}`);
        }
        seenPaths.add(relativePath);

        if (archiveEntry.isDirectory) {
          explicitDirectoryEntries.set(relativePath, archiveEntry);
          addDirectoryAndParents({ relativePath, directoryPaths, budget });
          continue;
        }
        reserveIndexedNode({ path: relativePath, budget });
        filesByPath.set(relativePath, { archiveEntry, relativePath });
        addDirectoryAndParents({
          relativePath: getParentRelativePath({ relativePath }),
          directoryPaths,
          budget,
        });
      }
    } finally {
      await source.close();
    }

    for (const filePath of filesByPath.keys()) {
      if (directoryPaths.has(filePath)) {
        throw new Error(`ZIP file path is also used as a directory: ${filePath}`);
      }
    }

    const mutableChildren = new Map<string, Map<string, ZipArchiveViewChild>>();
    const getChildren = ({ directoryPath }: { directoryPath: string }) => {
      let children = mutableChildren.get(directoryPath);
      if (children === undefined) {
        children = new Map();
        mutableChildren.set(directoryPath, children);
      }
      return children;
    };

    for (const directoryPath of directoryPaths) {
      if (directoryPath === "") {
        continue;
      }
      const parentPath = getParentRelativePath({ relativePath: directoryPath });
      const name = getBaseName({ relativePath: directoryPath });
      const explicitEntry = explicitDirectoryEntries.get(directoryPath);
      getChildren({ directoryPath: parentPath }).set(name, {
        name,
        relativePath: directoryPath,
        kind: "directory",
        size: undefined,
        lastModified: explicitEntry?.modifiedAt.getTime(),
      });
    }

    for (const file of filesByPath.values()) {
      const parentPath = getParentRelativePath({ relativePath: file.relativePath });
      const name = getBaseName({ relativePath: file.relativePath });
      const children = getChildren({ directoryPath: parentPath });
      if (children.has(name)) {
        throw new Error(`ZIP path conflicts with another entry: ${file.relativePath}`);
      }
      children.set(name, {
        name,
        relativePath: file.relativePath,
        kind: "file",
        size: file.archiveEntry.uncompressedSize,
        lastModified: file.archiveEntry.modifiedAt.getTime(),
      });
    }

    const childrenByDirectory = new Map<string, readonly ZipArchiveViewChild[]>();
    for (const [directoryPath, children] of mutableChildren) {
      childrenByDirectory.set(directoryPath, [...children.values()]);
    }

    return new ZipArchiveView({
      createSource,
      filesByPath,
      directoryPaths,
      childrenByDirectory,
    });
  }

  hasDirectory({ relativePath }: { relativePath: string }): boolean {
    return this.directoryPaths.has(relativePath);
  }

  hasFile({ relativePath }: { relativePath: string }): boolean {
    return this.filesByPath.has(relativePath);
  }

  listDirectory({ relativePath }: { relativePath: string }): readonly ZipArchiveViewChild[] {
    if (!this.directoryPaths.has(relativePath)) {
      throw new Error(`ZIP directory not found: ${relativePath}`);
    }
    return this.childrenByDirectory.get(relativePath) ?? [];
  }

  getFileSize({ relativePath }: { relativePath: string }): number {
    const file = this.filesByPath.get(relativePath);
    if (file === undefined) {
      throw new Error(`ZIP file not found: ${relativePath}`);
    }
    return file.archiveEntry.uncompressedSize;
  }

  getFileModifiedAt({ relativePath }: { relativePath: string }): number {
    const file = this.filesByPath.get(relativePath);
    if (file === undefined) {
      throw new Error(`ZIP file not found: ${relativePath}`);
    }
    return file.archiveEntry.modifiedAt.getTime();
  }

  async fileHasZipMagic({ relativePath }: { relativePath: string }): Promise<boolean> {
    const stream = await this.openFileStream({ relativePath });
    const streamReader = stream.getReader();
    const prefix = new Uint8Array(4);
    let prefixLength = 0;
    try {
      while (prefixLength < prefix.byteLength) {
        const { done, value } = await streamReader.read();
        if (done) {
          break;
        }
        const copyLength = Math.min(value.byteLength, prefix.byteLength - prefixLength);
        prefix.set(value.subarray(0, copyLength), prefixLength);
        prefixLength += copyLength;
      }
      return hasZipMagic({ bytes: prefix.subarray(0, prefixLength) });
    } finally {
      await streamReader.cancel().catch(() => undefined);
      streamReader.releaseLock();
    }
  }

  async openFileStream({ relativePath }: { relativePath: string }): Promise<ReadableStream<Uint8Array>> {
    const file = this.filesByPath.get(relativePath);
    if (file === undefined) {
      throw new Error(`ZIP file not found: ${relativePath}`);
    }
    const source = await this.createSource();
    const reader = new StreamingZipReader({
      source,
      compressionCodec: createWebZipCompressionCodec(),
    });
    let entryStream: ReadableStream<Uint8Array>;
    try {
      entryStream = await reader.openEntry({ entry: file.archiveEntry });
    } catch (error) {
      await source.close();
      throw error;
    }
    const entryReader = entryStream.getReader();
    let sourceClosed = false;
    const closeSource = async (): Promise<void> => {
      if (sourceClosed) {
        return;
      }
      sourceClosed = true;
      entryReader.releaseLock();
      await source.close();
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await entryReader.read();
          if (done) {
            controller.close();
            await closeSource();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          await closeSource();
        }
      },
      async cancel(reason) {
        try {
          await entryReader.cancel(reason);
        } finally {
          await closeSource();
        }
      },
    });
  }

  async readFileBlob({ relativePath }: { relativePath: string }): Promise<Blob> {
    const stream = await this.openFileStream({ relativePath });
    return new Response(stream).blob();
  }
}

export const TEST_ONLY = {
  hasZipMagic,
  normalizeArchiveEntryPath,
};
