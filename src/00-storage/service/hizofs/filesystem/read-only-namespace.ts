import {
  compareUnsignedBytes,
  encodeFilenameComponent,
  encodeHomeRecordReference,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type FileInodeEntry,
  type FileOffset,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafEntry,
  type InodeLeafPage,
  type InodeNumber,
  type InodeRevision,
  type SymlinkInodeEntry,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";

export type ReadOnlyNamespaceErrorCode =
  | "corrupt_namespace"
  | "not_directory"
  | "not_file"
  | "not_found"
  | "not_symlink"
  | "subvolume_boundary";

export class ReadOnlyNamespaceError extends Error {
  readonly code: ReadOnlyNamespaceErrorCode;

  constructor({ code, message }: { code: ReadOnlyNamespaceErrorCode; message: string }) {
    super(message);
    this.name = "ReadOnlyNamespaceError";
    this.code = code;
  }
}

export type ReadOnlyNamespacePageSource = Readonly<{
  readDirectoryPage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<DirectoryPage>;
  readExtentFile: ({ inode, length, offset }: {
    inode: FileInodeEntry & Readonly<{ content: Readonly<{ extentTreeRootHomeRef: HomeRecordReference; type: "tree" }> }>;
    length: bigint;
    offset: bigint;
  }) => Promise<Uint8Array>;
  readInodePage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<InodeBranchPage | InodeLeafPage>;
}>;

export type ReadOnlyInodeStat = Readonly<{
  createdAt: TimestampMilliseconds | null;
  fileSize?: FileOffset;
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  kind: InodeLeafEntry["inodeKind"];
  modifiedAt: TimestampMilliseconds | null;
}>;

export type ReadOnlyDirectoryListing = Readonly<{
  entries: readonly DirectoryLeafEntry[];
  truncated: boolean;
}>;

export type ReadOnlyNamespace = Readonly<{
  list: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<readonly DirectoryLeafEntry[]>;
  listBounded: ({ maximumEntries, pathComponents }: {
    maximumEntries: number;
    pathComponents: readonly string[];
  }) => Promise<ReadOnlyDirectoryListing>;
  readFile: ({ length, offset, pathComponents }: {
    length?: bigint;
    offset?: bigint;
    pathComponents: readonly string[];
  }) => Promise<Uint8Array>;
  readlink: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<string>;
  stat: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<ReadOnlyInodeStat>;
}>;

// Mutation planning needs authenticated raw inode and directory capabilities, but
// exporting them through ReadOnlyNamespace would turn private persisted structure
// into an application API. Keep the richer capability explicit and filesystem-owned.
export type ReadOnlyNamespaceResolver = ReadOnlyNamespace & Readonly<{
  knownInodeNumbers: () => Promise<readonly InodeNumber[]>;
  listDirectoryEntries: ({ inode }: { inode: DirectoryInodeEntry }) => Promise<readonly DirectoryLeafEntry[]>;
  listDirectoryEntriesAfterBounded: ({ afterName, inode, maximumEntries }: {
    afterName: string | undefined;
    inode: DirectoryInodeEntry;
    maximumEntries: number;
  }) => Promise<ReadOnlyDirectoryListing>;
  listDirectoryEntriesBounded: ({ inode, maximumEntries }: {
    inode: DirectoryInodeEntry;
    maximumEntries: number;
  }) => Promise<ReadOnlyDirectoryListing>;
  lookupDirectoryEntry: ({ directory, name }: {
    directory: DirectoryInodeEntry;
    name: string;
  }) => Promise<DirectoryLeafEntry | undefined>;
  resolveInode: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<InodeLeafEntry>;
  resolveInodeByNumber: ({ inodeNumber }: { inodeNumber: InodeNumber }) => Promise<InodeLeafEntry>;
}>;

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  let identity = "";
  for (const byte of encodeHomeRecordReference({ reference })) identity += byte.toString(16).padStart(2, "0");
  return identity;
}

function inodePageToImmutable({ page }: {
  page: InodeBranchPage | InodeLeafPage;
}): ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference> {
  if ("type" in page) return page;
  return {
    children: page.entries.map(entry => ({
      childPageReference: entry.childPageHomeRef,
      upperBound: entry.upperBound,
    })),
    level: page.level,
    type: "branch",
  };
}

function directoryPageToImmutable({ page }: {
  page: DirectoryPage;
}): ImmutableBTreePage<Uint8Array, DirectoryLeafEntry, HomeRecordReference> {
  switch (page.type) {
  case "leaf": return page;
  case "branch": return {
    children: page.entries.map(entry => ({
      childPageReference: entry.childPageHomeRef,
      upperBound: encodeFilenameComponent({ value: entry.upperBoundName }),
    })),
    level: page.level,
    type: "branch",
  };
  default: return page satisfies never;
  }
}

function requireRootDirectory({ inode }: { inode: InodeLeafEntry }): DirectoryInodeEntry {
  switch (inode.inodeKind) {
  case "directory": return inode;
  case "file":
  case "symlink": throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "root inode is not a directory" });
  default: return inode satisfies never;
  }
}

function requireDirectory({ inode, message }: { inode: InodeLeafEntry; message: string }): DirectoryInodeEntry {
  switch (inode.inodeKind) {
  case "directory": return inode;
  case "file":
  case "symlink": throw new ReadOnlyNamespaceError({ code: "not_directory", message });
  default: return inode satisfies never;
  }
}

function requireFile({ inode }: { inode: InodeLeafEntry }): FileInodeEntry {
  switch (inode.inodeKind) {
  case "file": return inode;
  case "directory":
  case "symlink": throw new ReadOnlyNamespaceError({ code: "not_file", message: "read target is not a file" });
  default: return inode satisfies never;
  }
}

function requireSymlink({ inode }: { inode: InodeLeafEntry }): SymlinkInodeEntry {
  switch (inode.inodeKind) {
  case "symlink": return inode;
  case "directory":
  case "file": throw new ReadOnlyNamespaceError({ code: "not_symlink", message: "readlink target is not a symbolic link" });
  default: return inode satisfies never;
  }
}

function projectStat({ inode }: { inode: InodeLeafEntry }): ReadOnlyInodeStat {
  const base = {
    createdAt: inode.timestamps.createdAt,
    inodeNumber: inode.inodeNumber,
    inodeRevision: inode.inodeRevision,
    kind: inode.inodeKind,
    modifiedAt: inode.timestamps.modifiedAt,
  };
  switch (inode.inodeKind) {
  case "file": return { ...base, fileSize: inode.fileSize };
  case "directory":
  case "symlink": return base;
  default: return inode satisfies never;
  }
}

function assertNonnegativeRange({ fileSize, length, offset }: {
  fileSize: bigint;
  length: bigint;
  offset: bigint;
}): void {
  if (offset < 0n || length < 0n) throw new RangeError("file read offset and length must be nonnegative");
  if (offset > fileSize || length > fileSize - offset) throw new RangeError("file read range exceeds file size");
}

export function createReadOnlyNamespaceResolver({ inodeTableRootHomeRef, rootDirectoryInodeNumber, source }: {
  inodeTableRootHomeRef: HomeRecordReference;
  rootDirectoryInodeNumber: InodeNumber;
  source: ReadOnlyNamespacePageSource;
}): ReadOnlyNamespaceResolver {
  const inodeReader = new ImmutableBTreeReader<InodeNumber, InodeLeafEntry, HomeRecordReference>({
    compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
    getEntryKey: ({ entry }) => entry.inodeNumber,
    pageReader: async ({ isRoot, reference }) => inodePageToImmutable({
      page: await source.readInodePage({ isRoot, reference }),
    }),
    referenceIdentity,
  });

  const directoryReader = new ImmutableBTreeReader<Uint8Array, DirectoryLeafEntry, HomeRecordReference>({
    compareKeys: compareUnsignedBytes,
    getEntryKey: ({ entry }) => encodeFilenameComponent({ value: entry.name }),
    pageReader: async ({ isRoot, reference }) => directoryPageToImmutable({
      page: await source.readDirectoryPage({ isRoot, reference }),
    }),
    referenceIdentity,
  });

  let inodeTableValidation: Promise<void> | undefined;
  const directoryTreeValidations = new Map<string, Promise<void>>();

  const validateInodeTable = async (): Promise<void> => {
    const existing = inodeTableValidation;
    if (existing !== undefined) return await existing;
    const pending = inodeReader.validateStructure({ rootReference: inodeTableRootHomeRef }).then(() => undefined);
    inodeTableValidation = pending;
    try {
      await pending;
    } catch (cause: unknown) {
      if (inodeTableValidation === pending) inodeTableValidation = undefined;
      throw cause;
    }
  };

  const validateDirectoryTree = async ({ rootReference }: {
    rootReference: HomeRecordReference;
  }): Promise<void> => {
    const identity = referenceIdentity({ reference: rootReference });
    const existing = directoryTreeValidations.get(identity);
    if (existing !== undefined) return await existing;
    const pending = directoryReader.validateStructure({ rootReference }).then(() => undefined);
    directoryTreeValidations.set(identity, pending);
    try {
      await pending;
    } catch (cause: unknown) {
      if (directoryTreeValidations.get(identity) === pending) directoryTreeValidations.delete(identity);
      throw cause;
    }
  };

  const getInode = async ({ inodeNumber }: { inodeNumber: InodeNumber }): Promise<InodeLeafEntry> => {
    // Point lookup alone can leave a corrupt sibling subtree unread. Validate
    // the complete immutable root before any namespace result becomes visible.
    await validateInodeTable();
    const inode = await inodeReader.get({ key: inodeNumber, rootReference: inodeTableRootHomeRef });
    if (inode === undefined) {
      throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "directory entry references a missing inode" });
    }
    return inode;
  };

  const listDirectoryEntries = async ({ inode }: { inode: DirectoryInodeEntry }): Promise<readonly DirectoryLeafEntry[]> => {
    switch (inode.content.type) {
    case "inline": return [...inode.content.entries];
    case "tree": {
      await validateDirectoryTree({ rootReference: inode.content.directoryTreeRootHomeRef });
      const entries: DirectoryLeafEntry[] = [];
      for await (const entry of directoryReader.entries({ rootReference: inode.content.directoryTreeRootHomeRef })) entries.push(entry);
      return entries;
    }
    default: return inode.content satisfies never;
    }
  };

  const listDirectoryEntriesAfterBounded = async ({ afterName, inode, maximumEntries }: {
    afterName: string | undefined;
    inode: DirectoryInodeEntry;
    maximumEntries: number;
  }): Promise<ReadOnlyDirectoryListing> => {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new RangeError("maximumEntries must be a nonnegative safe integer");
    }
    const afterKey = afterName === undefined ? undefined : encodeFilenameComponent({ value: afterName });
    const accept = ({ entry }: { entry: DirectoryLeafEntry }): boolean => afterKey === undefined
      || compareUnsignedBytes({ left: encodeFilenameComponent({ value: entry.name }), right: afterKey }) > 0;
    const entries: DirectoryLeafEntry[] = [];
    const append = ({ entry }: { entry: DirectoryLeafEntry }): boolean => {
      if (!accept({ entry })) return false;
      if (entries.length === maximumEntries) return true;
      entries.push(entry);
      return false;
    };
    switch (inode.content.type) {
    case "inline": {
      for (const entry of inode.content.entries) {
        if (append({ entry })) return { entries, truncated: true };
      }
      return { entries, truncated: false };
    }
    case "tree": {
      await validateDirectoryTree({ rootReference: inode.content.directoryTreeRootHomeRef });
      const iterable = afterKey === undefined
        ? directoryReader.entries({ rootReference: inode.content.directoryTreeRootHomeRef })
        : directoryReader.entriesFromFloor({ key: afterKey, rootReference: inode.content.directoryTreeRootHomeRef });
      for await (const entry of iterable) {
        if (append({ entry })) return { entries, truncated: true };
      }
      return { entries, truncated: false };
    }
    default: return inode.content satisfies never;
    }
  };

  const listDirectoryEntriesBounded = async ({ inode, maximumEntries }: {
    inode: DirectoryInodeEntry;
    maximumEntries: number;
  }): Promise<ReadOnlyDirectoryListing> => {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new RangeError("maximumEntries must be a nonnegative safe integer");
    }
    switch (inode.content.type) {
    case "inline":
      return {
        entries: inode.content.entries.slice(0, maximumEntries),
        truncated: inode.content.entries.length > maximumEntries,
      };
    case "tree": {
      await validateDirectoryTree({ rootReference: inode.content.directoryTreeRootHomeRef });
      const entries: DirectoryLeafEntry[] = [];
      let truncated = false;
      for await (const entry of directoryReader.entries({ rootReference: inode.content.directoryTreeRootHomeRef })) {
        if (entries.length === maximumEntries) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
      return { entries, truncated };
    }
    default: return inode.content satisfies never;
    }
  };

  const lookupDirectoryEntry = async ({ directory, name }: {
    directory: DirectoryInodeEntry;
    name: string;
  }): Promise<DirectoryLeafEntry | undefined> => {
    const key = encodeFilenameComponent({ value: name });
    switch (directory.content.type) {
    case "inline": {
      let lower = 0;
      let upper = directory.content.entries.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        const entry = directory.content.entries[middle];
        if (entry === undefined) throw new Error("inline directory binary-search invariant failed");
        if (compareUnsignedBytes({ left: encodeFilenameComponent({ value: entry.name }), right: key }) < 0) lower = middle + 1;
        else upper = middle;
      }
      const entry = directory.content.entries[lower];
      return entry !== undefined && compareUnsignedBytes({ left: encodeFilenameComponent({ value: entry.name }), right: key }) === 0
        ? entry
        : undefined;
    }
    case "tree": {
      await validateDirectoryTree({ rootReference: directory.content.directoryTreeRootHomeRef });
      return await directoryReader.get({ key, rootReference: directory.content.directoryTreeRootHomeRef });
    }
    default: return directory.content satisfies never;
    }
  };

  const resolveInode = async ({ pathComponents }: { pathComponents: readonly string[] }): Promise<InodeLeafEntry> => {
    let current: InodeLeafEntry = requireRootDirectory({
      inode: await getInode({ inodeNumber: rootDirectoryInodeNumber }),
    });
    for (const name of pathComponents) {
      encodeFilenameComponent({ value: name });
      const directory = requireDirectory({ inode: current, message: "path traverses through a non-directory inode" });
      const entry = await lookupDirectoryEntry({ directory, name });
      if (entry === undefined) throw new ReadOnlyNamespaceError({ code: "not_found", message: "path component does not exist" });
      switch (entry.targetType) {
      case "subvolume":
        throw new ReadOnlyNamespaceError({ code: "subvolume_boundary", message: "nested Subvolume traversal belongs to the Subvolume slice" });
      case "inode": {
        const inode = await getInode({ inodeNumber: entry.inodeNumber });
        if (inode.inodeKind !== entry.inodeKind) {
          throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "directory entry inode kind disagrees with the Inode Table" });
        }
        current = inode;
        break;
      }
      default: entry satisfies never;
      }
    }
    return current;
  };

  return {
    knownInodeNumbers: async () => {
      await validateInodeTable();
      const inodeNumbers: InodeNumber[] = [];
      for await (const entry of inodeReader.entries({ rootReference: inodeTableRootHomeRef })) {
        inodeNumbers.push(entry.inodeNumber);
      }
      return inodeNumbers;
    },
    list: async ({ pathComponents }) => {
      const inode = requireDirectory({
        inode: await resolveInode({ pathComponents }),
        message: "list target is not a directory",
      });
      return await listDirectoryEntries({ inode });
    },
    listBounded: async ({ maximumEntries, pathComponents }) => {
      const inode = requireDirectory({
        inode: await resolveInode({ pathComponents }),
        message: "list target is not a directory",
      });
      return await listDirectoryEntriesBounded({ inode, maximumEntries });
    },
    listDirectoryEntries,
    listDirectoryEntriesAfterBounded,
    listDirectoryEntriesBounded,
    lookupDirectoryEntry,
    readFile: async ({ length, offset = 0n, pathComponents }) => {
      const inode = requireFile({ inode: await resolveInode({ pathComponents }) });
      const requestedLength = length ?? inode.fileSize - offset;
      assertNonnegativeRange({ fileSize: inode.fileSize, length: requestedLength, offset });
      switch (inode.content.type) {
      case "inline": {
        const start = Number(offset);
        const end = Number(offset + requestedLength);
        return inode.content.bytes.slice(start, end);
      }
      case "tree": return await source.readExtentFile({ inode: { ...inode, content: inode.content }, length: requestedLength, offset });
      default: return inode.content satisfies never;
      }
    },
    readlink: async ({ pathComponents }) => {
      return requireSymlink({ inode: await resolveInode({ pathComponents }) }).target;
    },
    resolveInode,
    resolveInodeByNumber: getInode,
    stat: async ({ pathComponents }) => projectStat({ inode: await resolveInode({ pathComponents }) }),
  };
}

export function createReadOnlyNamespace({ inodeTableRootHomeRef, rootDirectoryInodeNumber, source }: {
  inodeTableRootHomeRef: HomeRecordReference;
  rootDirectoryInodeNumber: InodeNumber;
  source: ReadOnlyNamespacePageSource;
}): ReadOnlyNamespace {
  const resolver = createReadOnlyNamespaceResolver({ inodeTableRootHomeRef, rootDirectoryInodeNumber, source });
  // Strip resolver-only capabilities exhaustively. A future capability addition must
  // fail typechecking here instead of leaking through the ordinary read namespace.
  const {
    knownInodeNumbers: _knownInodeNumbers,
    list,
    listBounded,
    listDirectoryEntries: _listDirectoryEntries,
    listDirectoryEntriesAfterBounded: _listDirectoryEntriesAfterBounded,
    listDirectoryEntriesBounded: _listDirectoryEntriesBounded,
    lookupDirectoryEntry: _lookupDirectoryEntry,
    readFile,
    readlink,
    resolveInode: _resolveInode,
    resolveInodeByNumber: _resolveInodeByNumber,
    stat,
    ...unhandledResolver
  } = resolver;
  unhandledResolver satisfies Record<PropertyKey, never>;
  return { list, listBounded, readFile, readlink, stat };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
