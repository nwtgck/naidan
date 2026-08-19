import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createFileOffset,
  decodeCommonPageHeader,
  decodeDirectoryPage,
  decodeFileExtentPage,
  decodeIndexedInodeLeafEntry,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  findIndexedInodeLeafEntry,
  indexInodeLeafPage,
  encodeFilenameComponent,
  validateExtentAgainstReferencedData,
  type FileExtentLeafEntry,
  type FileExtentPage,
  type FileOffset,
  type FileSystemCommitPayload,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedNamespaceRecordSource } from "@/00-storage/service/hizofs/authenticated-store/namespace-record-source";
import {
  createReadOnlyNamespaceResolver,
  type ReadOnlyNamespace,
  type ReadOnlyNamespacePageSource,
  type ReadOnlyNamespaceResolver,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import type { DecodedInodeIndexPageCache } from "@/00-storage/service/hizofs/filesystem/decoded-inode-index-page-cache";
import type { DecodedDirectoryPageIndexCache } from "@/00-storage/service/hizofs/filesystem/decoded-directory-page-index-cache";
import { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { ImmutableBTreeDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";
import { findBranchChildIndex } from "@/00-storage/service/hizofs/indexes/ordering";

const MAXIMUM_SINGLE_NAMESPACE_READ_BYTES = 64 * 1024 * 1024;

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
}

function extentPageToImmutable({ page }: {
  page: FileExtentPage;
}): ImmutableBTreePage<FileOffset, FileExtentLeafEntry, HomeRecordReference> {
  switch (page.type) {
  case "leaf": return page;
  case "branch": return {
    children: page.entries.map(entry => ({
      childPageReference: entry.childPageHomeRef,
      upperBound: entry.upperBound,
    })),
    level: page.level,
    type: "branch",
  };
  default: return page satisfies never;
  }
}

function safeReadLength({ length }: { length: bigint }): number {
  if (length > BigInt(MAXIMUM_SINGLE_NAMESPACE_READ_BYTES)) {
    throw new RangeError(`single namespace read exceeds ${MAXIMUM_SINGLE_NAMESPACE_READ_BYTES} bytes`);
  }
  return Number(length);
}

export function createAuthenticatedReadOnlyNamespaceResolver({
  commit,
  decodedDirectoryPageIndexCache,
  decodedInodeIndexPageCache,
  indexDiagnostics,
  recordSource,
  validationCache,
}: {
  commit: FileSystemCommitPayload;
  decodedDirectoryPageIndexCache?: DecodedDirectoryPageIndexCache;
  decodedInodeIndexPageCache?: DecodedInodeIndexPageCache;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  recordSource: AuthenticatedNamespaceRecordSource;
  validationCache?: ReadOnlyNamespaceValidationCache;
}): ReadOnlyNamespaceResolver {
  const validations = validationCache ?? new ReadOnlyNamespaceValidationCache({ maximumEntries: 1_024 });
  const readPlaintext = async ({ expectedRecordKind, reference }: {
    expectedRecordKind: number;
    reference: HomeRecordReference;
  }): Promise<Uint8Array> => {
    if (reference.recordKind !== expectedRecordKind) {
      throw new TypeError("namespace Home Record Reference has the wrong Record Kind");
    }
    const record = await recordSource.readHomeRecord({ reference });
    if (record.recordKind !== expectedRecordKind) {
      record.plaintext.fill(0);
      throw new TypeError("authenticated namespace record has the wrong Record Kind");
    }
    return record.plaintext;
  };

  const source: ReadOnlyNamespacePageSource = {
    indexDiagnostics,
    readDirectoryPage: async ({ isRoot, reference }) => {
      const bytes = await readPlaintext({
        expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
        reference,
      });
      try {
        return recordSource.decodeRecordPayload({ decode: () => {
          const page = decodeDirectoryPage({ bytes, isRoot });
          decodedDirectoryPageIndexCache?.setPage({ encodedByteLength: bytes.byteLength, isRoot, page, reference });
          return page;
        } });
      } finally {
        bytes.fill(0);
      }
    },
    readDirectoryPointPage: async ({ isRoot, key, reference }) => {
      const cached = decodedDirectoryPageIndexCache?.getPoint({ isRoot, key, reference });
      if (cached !== undefined) return cached;
      const page = await source.readDirectoryPage({ isRoot, reference });
      const populated = decodedDirectoryPageIndexCache?.getPoint({ isRoot, key, reference });
      if (populated !== undefined) return populated;
      switch (page.type) {
      case "leaf": {
        let lower = 0;
        let upper = page.entries.length;
        while (lower < upper) {
          const middle = lower + Math.floor((upper - lower) / 2);
          const entry = page.entries[middle];
          if (entry === undefined) throw new Error("Directory point-read leaf invariant failed");
          const entryKey = encodeFilenameComponent({ value: entry.name });
          try {
            if (compareUnsignedBytes({ left: entryKey, right: key }) < 0) lower = middle + 1;
            else upper = middle;
          } finally {
            entryKey.fill(0);
          }
        }
        const entry = page.entries[lower];
        if (entry === undefined) return { entry: undefined, type: "leaf" as const };
        const entryKey = encodeFilenameComponent({ value: entry.name });
        try {
          return {
            entry: compareUnsignedBytes({ left: entryKey, right: key }) === 0 ? entry : undefined,
            type: "leaf" as const,
          };
        } finally {
          entryKey.fill(0);
        }
      }
      case "branch": {
        const keys = page.entries.map(entry => encodeFilenameComponent({ value: entry.upperBoundName }));
        try {
          const children = page.entries.map((entry, index) => {
            const upperBound = keys[index];
            if (upperBound === undefined) throw new Error("Directory point-read branch key invariant failed");
            return { childPageReference: entry.childPageHomeRef, upperBound };
          });
          const childIndex = findBranchChildIndex({
            children,
            compareKeys: compareUnsignedBytes,
            key,
          });
          const child = page.entries[childIndex];
          if (child === undefined) return { level: page.level, type: "absent" as const };
          return { childPageReference: child.childPageHomeRef, level: page.level, type: "branch" as const };
        } finally {
          for (const value of keys) value.fill(0);
        }
      }
      default: return page satisfies never;
      }
    },
    readExtentFile: async ({ inode, length, offset }) => {
      const output = new Uint8Array(safeReadLength({ length }));
      if (length === 0n) return output;
      const extentReader = new ImmutableBTreeReader<FileOffset, FileExtentLeafEntry, HomeRecordReference>({
        compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
        getEntryKey: ({ entry }) => entry.fileOffset,
        operationDiagnostics: indexDiagnostics,
        pageReader: async ({ isRoot, reference }) => {
          const bytes = await readPlaintext({
            expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
            reference,
          });
          try {
            return recordSource.decodeRecordPayload({
              decode: () => extentPageToImmutable({ page: decodeFileExtentPage({ bytes, isRoot }) }),
            });
          } finally {
            bytes.fill(0);
          }
        },
        referenceIdentity,
      });
      const extentRootReference = inode.content.extentTreeRootHomeRef;
      await validations.validateFileExtentTree({
        fileSize: inode.fileSize,
        rootReference: extentRootReference,
        validate: async () => {
          let previousExtentEnd: bigint | undefined;
          for await (const extent of extentReader.entries({ rootReference: extentRootReference })) {
            const extentEnd = extent.fileOffset + BigInt(extent.byteLength);
            if (previousExtentEnd !== undefined && extent.fileOffset < previousExtentEnd) {
              throw new TypeError("File Extent tree contains overlapping logical extents");
            }
            if (extentEnd > inode.fileSize) {
              throw new TypeError("File Extent tree contains an extent beyond the inode file size");
            }
            previousExtentEnd = extentEnd;
          }
        },
      });
      const requestedEnd = offset + length;
      const copyAuthenticatedExtentRange = async ({ copyEnd, copyStart, extent }: {
        copyEnd: bigint;
        copyStart: bigint;
        extent: FileExtentLeafEntry;
      }): Promise<void> => {
        const sourceStart = extent.dataOffset + Number(copyStart - extent.fileOffset);
        const sourceLength = Number(copyEnd - copyStart);
        const destinationStart = Number(copyStart - offset);
        await recordSource.copyFileDataRange({
          destination: output,
          destinationOffset: destinationStart,
          reference: extent.fileDataHomeRef,
          sourceLength,
          sourceOffset: sourceStart,
          validatePlaintextLength: ({ plaintextLength }) => validateExtentAgainstReferencedData({
            entry: extent,
            fileDataPlaintextLength: plaintextLength,
            inodeFileSize: inode.fileSize,
          }),
        });
      };

      const extentScan = await extentReader.seekFloorWithEntries({
        key: createFileOffset({ value: offset }),
        rootReference: extentRootReference,
      });
      const floorExtent = extentScan.floor;
      if (floorExtent !== undefined) {
        const floorExtentEnd = floorExtent.fileOffset + BigInt(floorExtent.byteLength);
        if (floorExtent.fileOffset <= offset && floorExtentEnd >= requestedEnd) {
          // WHY: a range proven to be fully covered by one authenticated Extent
          // needs only a floor lookup. Avoid constructing the general async
          // range cursor, but fall back unchanged for holes and boundary-crossing
          // reads so sparse and successor semantics stay owned by that path.
          await copyAuthenticatedExtentRange({ copyEnd: requestedEnd, copyStart: offset, extent: floorExtent });
          return output;
        }
      }

      let copiedUntil = offset;
      for await (const extent of extentScan.entries) {
        const extentEnd = extent.fileOffset + BigInt(extent.byteLength);
        if (extentEnd <= copiedUntil) continue;
        if (extent.fileOffset >= requestedEnd) return output;
        if (extent.fileOffset > copiedUntil) {
          // Extent gaps are authenticated sparse topology, not corruption. The
          // output buffer starts zeroed, so advance across the hole without
          // allocating or synthesizing a File Data Record.
          copiedUntil = extent.fileOffset < requestedEnd ? extent.fileOffset : requestedEnd;
          if (copiedUntil === requestedEnd) return output;
        }
        const copyStart = copiedUntil > extent.fileOffset ? copiedUntil : extent.fileOffset;
        const copyEnd = requestedEnd < extentEnd ? requestedEnd : extentEnd;
        await copyAuthenticatedExtentRange({ copyEnd, copyStart, extent });
        copiedUntil = copyEnd;
        if (copiedUntil === requestedEnd) return output;
      }
      // Any trailing logical range after the last extent is an implicit sparse
      // hole and remains zero in the bounded output buffer.
      return output;
    },
    readInodePointPage: async ({ inodeNumber, isRoot, reference }) => {
      const cachedBranch = decodedInodeIndexPageCache?.getBranchPage({ isRoot, reference });
      if (cachedBranch !== undefined) return { page: cachedBranch, type: "branch" as const };
      const bytes = await readPlaintext({
        expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        reference,
      });
      try {
        return recordSource.decodeRecordPayload({ decode: () => {
          const header = decodeCommonPageHeader({ bytes, family: "inode", isRoot });
          if (header.level !== 0) {
            decodedInodeIndexPageCache?.recordBranchPageDecode({ pageBytes: bytes.byteLength });
            const page = decodeInodeBranchPage({ bytes, isRoot });
            decodedInodeIndexPageCache?.setBranchPage({ isRoot, page, reference });
            return { page, type: "branch" as const };
          }
          let index = decodedInodeIndexPageCache?.getLeafIndex({ isRoot, reference });
          if (index === undefined) {
            index = indexInodeLeafPage({ bytes, isRoot });
            index = decodedInodeIndexPageCache?.setLeafIndex({
              index,
              isRoot,
              pageBytes: bytes.byteLength,
              reference,
            }) ?? index;
          }
          const entryIndex = findIndexedInodeLeafEntry({ index, inodeNumber });
          if (entryIndex === undefined) {
            decodedInodeIndexPageCache?.recordSelectiveEntryMiss({ pageBytes: bytes.byteLength });
            return { entry: undefined, type: "leaf" as const };
          }
          const entry = decodeIndexedInodeLeafEntry({ bytes, entryIndex, index });
          const entryBytes = index.entryLengths[entryIndex];
          if (entryBytes === undefined) throw new Error("Inode leaf-page index entry length is missing");
          decodedInodeIndexPageCache?.recordSelectiveEntryHit({
            entryBytes,
            pageBytes: bytes.byteLength,
          });
          return { entry, type: "leaf" as const };
        } });
      } finally {
        bytes.fill(0);
      }
    },
    readInodePage: async ({ isRoot, reference }) => {
      const bytes = await readPlaintext({
        expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        reference,
      });
      try {
        return recordSource.decodeRecordPayload({ decode: () => {
          const header = decodeCommonPageHeader({ bytes, family: "inode", isRoot });
          return header.level === 0
            ? decodeInodeLeafPage({ bytes, isRoot })
            : decodeInodeBranchPage({ bytes, isRoot });
        } });
      } finally {
        bytes.fill(0);
      }
    },
  };

  return createReadOnlyNamespaceResolver({
    inodeTableRootHomeRef: commit.rootInodeTableRootHomeRef,
    rootDirectoryInodeNumber: commit.rootDirectoryInodeNumber,
    source,
    validationCache: validations,
  });
}

export function createAuthenticatedReadOnlyNamespace({
  commit,
  indexDiagnostics,
  recordSource,
}: {
  commit: FileSystemCommitPayload;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  recordSource: AuthenticatedNamespaceRecordSource;
}): ReadOnlyNamespace {
  const resolver = createAuthenticatedReadOnlyNamespaceResolver({ commit, indexDiagnostics, recordSource });
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
