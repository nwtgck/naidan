import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  decodeCommonPageHeader,
  decodeDirectoryPage,
  decodeFileDataPayload,
  decodeFileExtentPage,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  encodeHomeRecordReference,
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
import type { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { ImmutableBTreeDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";

const MAXIMUM_SINGLE_NAMESPACE_READ_BYTES = 64 * 1024 * 1024;

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
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
  indexDiagnostics,
  recordSource,
  validationCache,
}: {
  commit: FileSystemCommitPayload;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  recordSource: AuthenticatedNamespaceRecordSource;
  validationCache?: ReadOnlyNamespaceValidationCache;
}): ReadOnlyNamespaceResolver {
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
        return recordSource.decodeRecordPayload({ decode: () => decodeDirectoryPage({ bytes, isRoot }) });
      } finally {
        bytes.fill(0);
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
      const requestedEnd = offset + length;
      let copiedUntil = offset;
      for await (const extent of extentReader.entriesFromFloor({
        key: createFileOffset({ value: offset }),
        rootReference: inode.content.extentTreeRootHomeRef,
      })) {
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
        const record = await recordSource.readHomeRecord({ reference: extent.fileDataHomeRef });
        try {
          if (record.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data) {
            throw new TypeError("file extent references a non-File-Data Record");
          }
          const payload = recordSource.decodeRecordPayload({
            decode: () => decodeFileDataPayload({ bytes: record.plaintext }),
          });
          try {
            validateExtentAgainstReferencedData({
              entry: extent,
              fileDataPlaintextLength: payload.bytes.byteLength,
              inodeFileSize: inode.fileSize,
            });
            const copyStart = copiedUntil > extent.fileOffset ? copiedUntil : extent.fileOffset;
            const copyEnd = requestedEnd < extentEnd ? requestedEnd : extentEnd;
            const sourceStart = extent.dataOffset + Number(copyStart - extent.fileOffset);
            const sourceEnd = sourceStart + Number(copyEnd - copyStart);
            const destinationStart = Number(copyStart - offset);
            output.set(payload.bytes.subarray(sourceStart, sourceEnd), destinationStart);
            copiedUntil = copyEnd;
            if (copiedUntil === requestedEnd) return output;
          } finally {
            payload.bytes.fill(0);
          }
        } finally {
          record.plaintext.fill(0);
        }
      }
      // Any trailing logical range after the last extent is an implicit sparse
      // hole and remains zero in the bounded output buffer.
      return output;
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
    validationCache,
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
