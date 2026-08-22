import {
  compareFilenameComponentsByUtf8,
  compareUnsignedBytes,
  encodeFilenameComponent,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type FileInodeEntry,
  type FileOffset,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafEntry,
  type InodeLeafPage,
  createInodeNumber,
  type InodeNumber,
  type InodeRevision,
  type SymlinkInodeEntry,
  type TimestampMilliseconds,
  UINT64_MAXIMUM,
} from "@/00-storage/service/hizofs/00-format";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import { measureImmutableBTreeOperation } from "@/00-storage/service/hizofs/indexes/diagnostics-hooks";
import { findBranchChildIndex } from "@/00-storage/service/hizofs/indexes/ordering";
import type { ImmutableBTreeDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";
import { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";

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
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  readDirectoryPage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<DirectoryPage>;
  readDirectoryPointPage?: ({ isRoot, key, reference }: {
    isRoot: boolean;
    key: Uint8Array;
    reference: HomeRecordReference;
  }) => Promise<
    | Readonly<{ level: number; type: "absent" }>
    | Readonly<{ childPageReference: HomeRecordReference; level: number; type: "branch" }>
    | Readonly<{ entry: DirectoryLeafEntry | undefined; type: "leaf" }>
  >;
  readExtentFile: ({ inode, length, offset }: {
    inode: FileInodeEntry & Readonly<{ content: Readonly<{ extentTreeRootHomeRef: HomeRecordReference; type: "tree" }> }>;
    length: bigint;
    offset: bigint;
  }) => Promise<Uint8Array>;
  readInodePage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<InodeBranchPage | InodeLeafPage>;
  readInodePointPage?: ({ inodeNumber, isRoot, reference }: {
    inodeNumber: InodeNumber;
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<
    | Readonly<{ entry: InodeLeafEntry | undefined; type: "leaf" }>
    | Readonly<{ page: InodeBranchPage; type: "branch" }>
  >;
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
  listAfterBounded?: ({ afterName, maximumEntries, pathComponents }: {
    afterName: string | undefined;
    maximumEntries: number;
    pathComponents: readonly string[];
  }) => Promise<ReadOnlyDirectoryListing>;
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
  maximumKnownInodeNumber: () => Promise<InodeNumber | undefined>;
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
  resolveDirectoryWithAncestors: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<Readonly<{
    ancestorDirectoryInodeNumbers: readonly InodeNumber[];
    directory: DirectoryInodeEntry;
  }>>;
  resolveInode: ({ pathComponents }: { pathComponents: readonly string[] }) => Promise<InodeLeafEntry>;
  resolveInodeByNumber: ({ inodeNumber }: { inodeNumber: InodeNumber }) => Promise<InodeLeafEntry>;
  validateDirectoryStructure: ({ directory }: { directory: DirectoryInodeEntry }) => Promise<void>;
}>;

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
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

export function createReadOnlyNamespaceResolver({ inodeTableRootHomeRef, rootDirectoryInodeNumber, source, validationCache }: {
  inodeTableRootHomeRef: HomeRecordReference;
  rootDirectoryInodeNumber: InodeNumber;
  source: ReadOnlyNamespacePageSource;
  validationCache?: ReadOnlyNamespaceValidationCache;
}): ReadOnlyNamespaceResolver {
  const inodeReader = new ImmutableBTreeReader<InodeNumber, InodeLeafEntry, HomeRecordReference>({
    compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
    getEntryKey: ({ entry }) => entry.inodeNumber,
    operationDiagnostics: source.indexDiagnostics,
    pageReader: async ({ isRoot, reference }) => inodePageToImmutable({
      page: await source.readInodePage({ isRoot, reference }),
    }),
    referenceIdentity,
  });

  const directoryReader = new ImmutableBTreeReader<Uint8Array, DirectoryLeafEntry, HomeRecordReference>({
    compareKeys: compareUnsignedBytes,
    getEntryKey: ({ entry }) => encodeFilenameComponent({ value: entry.name }),
    operationDiagnostics: source.indexDiagnostics,
    pageReader: async ({ isRoot, reference }) => directoryPageToImmutable({
      page: await source.readDirectoryPage({ isRoot, reference }),
    }),
    referenceIdentity,
  });

  const validations = validationCache ?? new ReadOnlyNamespaceValidationCache({ maximumEntries: 1_024 });
  let pagedDirectoryTreeCursorCache: Readonly<{
    cursor: ReturnType<typeof directoryReader.createForwardCursor>;
    expectedAfterName: string | undefined;
    rootReferenceIdentity: string;
  }> | undefined;

  const validateDirectoryTree = async ({ rootReference }: {
    rootReference: HomeRecordReference;
  }): Promise<void> => {
    await validations.validate({
      kind: "directory_tree",
      reference: rootReference,
      validate: async () => await directoryReader.validateStructure({ rootReference }).then(() => undefined),
    });
  };

  const getValidatedDirectoryPoint = async ({ key, rootReference }: {
    key: Uint8Array;
    rootReference: HomeRecordReference;
  }): Promise<DirectoryLeafEntry | undefined> => {
    const pointReader = source.readDirectoryPointPage;
    if (pointReader === undefined) return await directoryReader.get({ key, rootReference });
    return await measureImmutableBTreeOperation({
      diagnostics: source.indexDiagnostics,
      operation: "get",
      run: async ({ structural }) => {
        const visited = new Set<string>();
        let expectedLevel: number | undefined;
        let isRoot = true;
        let reference = rootReference;
        while (true) {
          const identity = referenceIdentity({ reference });
          if (visited.has(identity)) throw new TypeError("B-tree contains a cycle or duplicate page reference");
          visited.add(identity);
          const point = await pointReader({ isRoot, key, reference });
          const level = (() => {
            switch (point.type) {
            case "absent": return point.level;
            case "leaf": return 0;
            case "branch": return point.level;
            default: return point satisfies never;
            }
          })();
          if (structural !== undefined) {
            structural.pageReads += 1;
            structural.maximumPageLevel = Math.max(structural.maximumPageLevel, level);
          }
          if (expectedLevel !== undefined && level !== expectedLevel) {
            throw new TypeError("B-tree child level does not decrease by exactly one");
          }
          switch (point.type) {
          case "absent": return undefined;
          case "leaf": return point.entry;
          case "branch":
            if (point.level < 1) throw new RangeError("B-tree branch level must be a positive safe integer");
            expectedLevel = point.level - 1;
            reference = point.childPageReference;
            isRoot = false;
            break;
          default: return point satisfies never;
          }
        }
      },
    });
  };

  const getValidatedInodePoint = async ({ inodeNumber }: {
    inodeNumber: InodeNumber;
  }): Promise<InodeLeafEntry | undefined> => {
    const pointReader = source.readInodePointPage;
    if (pointReader === undefined) {
      return await inodeReader.get({ key: inodeNumber, rootReference: inodeTableRootHomeRef });
    }
    return await measureImmutableBTreeOperation({
      diagnostics: source.indexDiagnostics,
      operation: "get",
      run: async ({ structural }) => {
        const visited = new Set<string>();
        let expectedLevel: number | undefined;
        let isRoot = true;
        let reference = inodeTableRootHomeRef;
        while (true) {
          const identity = referenceIdentity({ reference });
          if (visited.has(identity)) throw new TypeError("B-tree contains a cycle or duplicate page reference");
          visited.add(identity);
          const point = await pointReader({ inodeNumber, isRoot, reference });
          const level = (() => {
            switch (point.type) {
            case "leaf": return 0;
            case "branch": return point.page.level;
            default: return point satisfies never;
            }
          })();
          if (structural !== undefined) {
            structural.pageReads += 1;
            structural.maximumPageLevel = Math.max(structural.maximumPageLevel, level);
          }
          if (expectedLevel !== undefined && level !== expectedLevel) {
            throw new TypeError("B-tree child level does not equal parent level minus one");
          }
          switch (point.type) {
          case "leaf": return point.entry;
          case "branch": {
            // The exact immutable root was fully validated before this point.
            // Reuse that proof while decoding only branch routing metadata and
            // the selected leaf entry for subsequent point lookups.
            const page = inodePageToImmutable({ page: point.page });
            switch (page.type) {
            case "branch": {
              const index = findBranchChildIndex({
                children: page.children,
                compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
                key: inodeNumber,
              });
              const child = page.children[index];
              if (child === undefined) return undefined;
              expectedLevel = page.level - 1;
              isRoot = false;
              reference = child.childPageReference;
              break;
            }
            case "leaf": throw new Error("Inode point-page branch projection produced a leaf");
            default: return page satisfies never;
            }
            break;
          }
          default: return point satisfies never;
          }
        }
      },
    });
  };

  const getInodeUnderNamespaceGraphProof = async ({ inodeNumber }: {
    inodeNumber: InodeNumber;
  }): Promise<InodeLeafEntry> => {
    // WHY: every caller is downstream of validateNamespaceGraph(), whose exact
    // immutable proof already traversed and structurally validated the complete
    // Inode Table. Re-entering a separate Inode Table validation here is redundant and can
    // force a second full traversal when a deliberately tiny proof cache cannot
    // retain both the graph proof and its component-tree proof.
    const inode = await getValidatedInodePoint({ inodeNumber });
    if (inode === undefined) {
      throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "directory entry references a missing inode" });
    }
    return inode;
  };

  const listDirectoryEntries = async ({ inode }: { inode: DirectoryInodeEntry }): Promise<readonly DirectoryLeafEntry[]> => {
    switch (inode.content.type) {
    case "inline": return [...inode.content.entries];
    case "tree": {
      const rootReference = inode.content.directoryTreeRootHomeRef;
      const entries: DirectoryLeafEntry[] = [];
      for await (const entry of directoryReader.entries({ rootReference })) entries.push(entry);
      // WHY: entries() consumed to completion already proves the exact immutable
      // tree structurally, including sibling ordering. Publish that proof only
      // after successful completion so namespace graph validation does not read
      // every Directory page twice before the first point lookup.
      validations.rememberValidatedFullTraversal({ kind: "directory_tree", reference: rootReference });
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
    const accept = ({ entry }: { entry: DirectoryLeafEntry }): boolean => afterName === undefined
      || compareFilenameComponentsByUtf8({ left: entry.name, right: afterName }) > 0;
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
      const rootReference = inode.content.directoryTreeRootHomeRef;
      const rootReferenceIdentity = referenceIdentity({ reference: rootReference });
      const cached = pagedDirectoryTreeCursorCache;
      if (
        cached !== undefined
        && cached.rootReferenceIdentity === rootReferenceIdentity
        && cached.expectedAfterName === afterName
      ) {
        // WHY: this cursor is created only after a complete validation of this
        // exact immutable Directory root. Its continuation therefore remains a
        // proof witness even if the shared validation cache later evicts that
        // redundant proof entry. Revalidating here can turn bounded pagination
        // back into a whole-tree scan at an arbitrary page boundary.
        pagedDirectoryTreeCursorCache = undefined;
        const listing = await cached.cursor.nextBounded({ maximumEntries });
        if (listing.truncated) {
          pagedDirectoryTreeCursorCache = {
            cursor: cached.cursor,
            expectedAfterName: listing.entries.at(-1)?.name ?? afterName,
            rootReferenceIdentity,
          };
        }
        return listing;
      }

      await validateDirectoryTree({ rootReference });
      if (afterName === undefined) {
        // WHY: a Storage directory iterator always starts at the beginning of
        // one immutable snapshot. Keep one depth-bounded B-tree cursor so its
        // later pages do not restart the root-to-leaf traversal. Arbitrary
        // afterName seeks keep the stateless fallback below.
        pagedDirectoryTreeCursorCache = undefined;
        const forwardCursor = directoryReader.createForwardCursor({ rootReference });
        const listing = await forwardCursor.nextBounded({ maximumEntries });
        if (listing.truncated) {
          pagedDirectoryTreeCursorCache = {
            cursor: forwardCursor,
            expectedAfterName: listing.entries.at(-1)?.name ?? afterName,
            rootReferenceIdentity,
          };
        }
        return listing;
      }

      const afterKey = encodeFilenameComponent({ value: afterName });
      try {
        const iterable = directoryReader.entriesFromFloor({ key: afterKey, rootReference });
        for await (const entry of iterable) {
          if (append({ entry })) return { entries, truncated: true };
        }
        return { entries, truncated: false };
      } finally {
        afterKey.fill(0);
      }
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
      return await getValidatedDirectoryPoint({ key, rootReference: directory.content.directoryTreeRootHomeRef });
    }
    default: return directory.content satisfies never;
    }
  };

  const validateNamespaceGraph = async (): Promise<void> => {
    await validations.validateNamespaceGraph({
      inodeTableRootReference: inodeTableRootHomeRef,
      rootDirectoryInodeNumber,
      validate: async () => {
        // WHY: record authentication and individual B+tree structural proofs do
        // not prove filesystem topology. One immutable Inode Table root owns
        // the complete ordinary namespace, so prove one-parent reachability
        // once for that exact root before exposing any namespace-dependent
        // result. The cache shares only the completed proof, never partial
        // traversal state.
        // The complete entries() traversal below is itself the exact Inode
        // Table structural proof. Do not nest a second cached validation under
        // this pending namespace-graph proof: that both reads the immutable
        // tree twice and can self-wait when the validation cache is saturated.
        // Keep only the not-yet-reached ordinary inode kinds. Removing each
        // inode on first reach proves uniqueness while avoiding a second
        // namespace-sized Set. Duplicate/cycle corruption takes the slower
        // point-read path below only to distinguish it from a dangling target.
        const remainingInodeKinds = new Map<InodeNumber, InodeLeafEntry["inodeKind"]>();
        let rootDirectoryInode: InodeLeafEntry | undefined;
        for await (const inode of inodeReader.entries({ rootReference: inodeTableRootHomeRef })) {
          remainingInodeKinds.set(inode.inodeNumber, inode.inodeKind);
          if (inode.inodeNumber === rootDirectoryInodeNumber) rootDirectoryInode = inode;
        }
        // entries() reached completion, so it established the same complete
        // structural proof that a separate Inode Table validation would have produced.
        validations.rememberValidatedFullTraversal({ kind: "inode_table", reference: inodeTableRootHomeRef });
        if (rootDirectoryInode === undefined) {
          throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "root inode is missing or is not a directory" });
        }
        switch (rootDirectoryInode.inodeKind) {
        case "directory": break;
        case "file":
        case "symlink":
          throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "root inode is missing or is not a directory" });
        default: rootDirectoryInode satisfies never;
        }
        remainingInodeKinds.delete(rootDirectoryInodeNumber);

        const pendingDirectoryInodeNumbers: InodeNumber[] = [rootDirectoryInodeNumber];
        while (pendingDirectoryInodeNumbers.length > 0) {
          const directoryInodeNumber = pendingDirectoryInodeNumbers.pop();
          if (directoryInodeNumber === undefined) throw new Error("namespace validation directory stack invariant failed");
          const inode = directoryInodeNumber === rootDirectoryInodeNumber
            ? rootDirectoryInode
            : await getValidatedInodePoint({ inodeNumber: directoryInodeNumber });
          if (inode === undefined || inode.inodeKind !== "directory") {
            throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "reachable directory inode is missing or changed kind" });
          }
          for (const entry of await listDirectoryEntries({ inode })) {
            switch (entry.targetType) {
            case "subvolume":
              // Mounted Subvolume topology has a separate cross-record proof.
              // Its root inode belongs to the child Subvolume Inode Table, not
              // this ordinary namespace graph.
              break;
            case "inode": {
              const inodeKind = remainingInodeKinds.get(entry.inodeNumber);
              if (inodeKind === undefined) {
                const existing = await getValidatedInodePoint({ inodeNumber: entry.inodeNumber });
                if (existing === undefined) {
                  throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "directory entry references a missing inode" });
                }
                throw new ReadOnlyNamespaceError({
                  code: "corrupt_namespace",
                  message: "ordinary inode has more than one parent or the directory graph contains a cycle",
                });
              }
              if (inodeKind !== entry.inodeKind) {
                throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "directory entry inode kind disagrees with the Inode Table" });
              }
              remainingInodeKinds.delete(entry.inodeNumber);
              switch (inodeKind) {
              case "directory": pendingDirectoryInodeNumbers.push(entry.inodeNumber); break;
              case "file":
              case "symlink": break;
              default: inodeKind satisfies never;
              }
              break;
            }
            default: entry satisfies never;
            }
          }
        }
        if (remainingInodeKinds.size !== 0) {
          throw new ReadOnlyNamespaceError({ code: "corrupt_namespace", message: "Inode Table contains an orphan ordinary inode" });
        }
      },
    });
  };

  const resolveInodeUnchecked = async ({ pathComponents }: { pathComponents: readonly string[] }): Promise<InodeLeafEntry> => {
    let current: InodeLeafEntry = requireRootDirectory({
      inode: await getInodeUnderNamespaceGraphProof({ inodeNumber: rootDirectoryInodeNumber }),
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
        const inode = await getInodeUnderNamespaceGraphProof({ inodeNumber: entry.inodeNumber });
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

  const resolveInode = async ({ pathComponents }: { pathComponents: readonly string[] }): Promise<InodeLeafEntry> => {
    await validateNamespaceGraph();
    return await resolveInodeUnchecked({ pathComponents });
  };

  const resolveDirectoryWithAncestors = async ({ pathComponents }: {
    pathComponents: readonly string[];
  }): Promise<Readonly<{
    ancestorDirectoryInodeNumbers: readonly InodeNumber[];
    directory: DirectoryInodeEntry;
  }>> => {
    await validateNamespaceGraph();
    let directory = requireRootDirectory({
      inode: await getInodeUnderNamespaceGraphProof({ inodeNumber: rootDirectoryInodeNumber }),
    });
    const ancestorDirectoryInodeNumbers: InodeNumber[] = [directory.inodeNumber];
    for (const name of pathComponents) {
      encodeFilenameComponent({ value: name });
      const entry = await lookupDirectoryEntry({ directory, name });
      if (entry === undefined) {
        throw new ReadOnlyNamespaceError({ code: "not_found", message: "path component does not exist" });
      }
      switch (entry.targetType) {
      case "subvolume":
        throw new ReadOnlyNamespaceError({
          code: "subvolume_boundary",
          message: "nested Subvolume traversal belongs to the Subvolume slice",
        });
      case "inode": {
        const inode = await getInodeUnderNamespaceGraphProof({ inodeNumber: entry.inodeNumber });
        if (inode.inodeKind !== entry.inodeKind) {
          throw new ReadOnlyNamespaceError({
            code: "corrupt_namespace",
            message: "directory entry inode kind disagrees with the Inode Table",
          });
        }
        directory = requireDirectory({ inode, message: "directory path traverses through a non-directory inode" });
        ancestorDirectoryInodeNumbers.push(directory.inodeNumber);
        break;
      }
      default: entry satisfies never;
      }
    }
    return { ancestorDirectoryInodeNumbers, directory };
  };

  let pagedDirectoryResolutionCache: Readonly<{
    inode: DirectoryInodeEntry;
    pathComponents: readonly string[];
  }> | undefined;
  const resolvePagedDirectory = async ({ pathComponents }: {
    pathComponents: readonly string[];
  }): Promise<DirectoryInodeEntry> => {
    const cached = pagedDirectoryResolutionCache;
    if (
      cached !== undefined
      && cached.pathComponents.length === pathComponents.length
      && cached.pathComponents.every((component, index) => component === pathComponents[index])
    ) {
      return cached.inode;
    }
    const inode = requireDirectory({
      inode: await resolveInode({ pathComponents }),
      message: "list target is not a directory",
    });
    // WHY: one paged iterator repeatedly asks the same immutable resolver for
    // the same directory. Retain only the most recent resolved inode so page
    // boundaries do not repeat path traversal; interleaved directories merely
    // replace this one-entry cache and therefore cannot grow retained memory.
    pagedDirectoryResolutionCache = { inode, pathComponents: [...pathComponents] };
    return inode;
  };

  return {
    maximumKnownInodeNumber: async () => {
      await validateNamespaceGraph();
      // Allocator regression detection needs only the highest persisted identity.
      // validateNamespaceGraph() already proved this exact immutable Inode
      // Table, so do not repeat its full structural validation before the
      // high-water seek. A retained component-tree proof can still cache the
      // derived high-water result when capacity permits.
      const cachedProof = validations.inodeTableHighWaterProof({ reference: inodeTableRootHomeRef });
      if (cachedProof !== undefined) return cachedProof.maximumKnownInodeNumber;
      const maximumKnownInodeNumber = (await inodeReader.seekFloor({
        key: createInodeNumber({ value: UINT64_MAXIMUM }),
        rootReference: inodeTableRootHomeRef,
      }))?.inodeNumber;
      validations.rememberInodeTableHighWaterProof({
        maximumKnownInodeNumber,
        reference: inodeTableRootHomeRef,
      });
      return maximumKnownInodeNumber;
    },
    list: async ({ pathComponents }) => {
      const inode = requireDirectory({
        inode: await resolveInode({ pathComponents }),
        message: "list target is not a directory",
      });
      return await listDirectoryEntries({ inode });
    },
    listAfterBounded: async ({ afterName, maximumEntries, pathComponents }) => {
      const inode = await resolvePagedDirectory({ pathComponents });
      return await listDirectoryEntriesAfterBounded({ afterName, inode, maximumEntries });
    },
    listBounded: async ({ maximumEntries, pathComponents }) => {
      const inode = requireDirectory({
        inode: await resolveInode({ pathComponents }),
        message: "list target is not a directory",
      });
      return await listDirectoryEntriesBounded({ inode, maximumEntries });
    },
    listDirectoryEntries: async ({ inode }) => {
      await validateNamespaceGraph();
      return await listDirectoryEntries({ inode });
    },
    listDirectoryEntriesAfterBounded: async ({ afterName, inode, maximumEntries }) => {
      await validateNamespaceGraph();
      return await listDirectoryEntriesAfterBounded({ afterName, inode, maximumEntries });
    },
    listDirectoryEntriesBounded: async ({ inode, maximumEntries }) => {
      await validateNamespaceGraph();
      return await listDirectoryEntriesBounded({ inode, maximumEntries });
    },
    lookupDirectoryEntry: async ({ directory, name }) => {
      await validateNamespaceGraph();
      return await lookupDirectoryEntry({ directory, name });
    },
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
    resolveDirectoryWithAncestors,
    resolveInode,
    resolveInodeByNumber: async ({ inodeNumber }) => {
      await validateNamespaceGraph();
      return await getInodeUnderNamespaceGraphProof({ inodeNumber });
    },
    stat: async ({ pathComponents }) => projectStat({ inode: await resolveInode({ pathComponents }) }),
    validateDirectoryStructure: async ({ directory }) => {
      await validateNamespaceGraph();
      switch (directory.content.type) {
      case "inline": return;
      case "tree": await validateDirectoryTree({ rootReference: directory.content.directoryTreeRootHomeRef }); return;
      default: return directory.content satisfies never;
      }
    },
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
    maximumKnownInodeNumber: _maximumKnownInodeNumber,
    list,
    listAfterBounded,
    listBounded,
    listDirectoryEntries: _listDirectoryEntries,
    listDirectoryEntriesAfterBounded: _listDirectoryEntriesAfterBounded,
    listDirectoryEntriesBounded: _listDirectoryEntriesBounded,
    lookupDirectoryEntry: _lookupDirectoryEntry,
    readFile,
    readlink,
    resolveDirectoryWithAncestors: _resolveDirectoryWithAncestors,
    resolveInode: _resolveInode,
    resolveInodeByNumber: _resolveInodeByNumber,
    stat,
    validateDirectoryStructure: _validateDirectoryStructure,
    ...unhandledResolver
  } = resolver;
  unhandledResolver satisfies Record<PropertyKey, never>;
  return { list, listAfterBounded, listBounded, readFile, readlink, stat };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
