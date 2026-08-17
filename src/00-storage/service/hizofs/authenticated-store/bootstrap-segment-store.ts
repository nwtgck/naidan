import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createRecordFrameHeader,
  createSubvolumeId,
  createUInt64,
  decodeFileSystemCommitPayload,
  encodeFileSystemCommitPayload,
  encodeInodeLeafPage,
  encodeRecordFrameHeader,
  encodeSegmentHeader,
  segmentHeaderAuthenticatedPrefix,
  segmentIdToShard,
  validateActiveCommitAuthority,
  type CommitSequence,
  type DirectoryInodeEntry,
  type FileSystemCommitPayload,
  type FileSystemId,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
  type MutationId,
  type PhysicalRecordReference,
  type RecordFrameHeaderV1,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  encryptRecord,
  encryptSegmentHeader,
  generateMutationId,
  generateRecordNonce,
  generateSegmentId,
  plaintextRecordBytes,
  plaintextSegmentHeaderBytes,
  type FileSystemRootKey,
  type RandomByteSource,
  type RecordNonce,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  canonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import { ensureAuthenticatedContainerDirectoryHierarchy } from "./ensure-container-directory";
import { resolveAuthenticatedHomeRecord } from "./relocation-index-reader";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "./physical-bytes";
import {
  measureAuthenticatedCodecOperation,
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import { authenticatedSegmentPath, segmentIdIsUsedAcrossClasses } from "./segment-location";
import { readAuthenticatedInodeTablePage } from "./inode-table-page-store";
import { runtimeHomeRecordReferenceIdentity } from "./runtime-home-record-reference-identity";
import { createAuthenticatedWholeFile } from "./whole-file";

export type InitialBootstrapAuthority = Readonly<{
  activeCommitHomeRef: HomeRecordReference;
  activeCommitSequence: CommitSequence;
  activeMutationId: MutationId;
}>;


export type BootstrapCommitAuthority =
  | Readonly<{
    commitHomeRef: HomeRecordReference;
    commitSequence: CommitSequence;
    mutationId: MutationId;
    type: "active";
  }>
  | Readonly<{
    commitHomeRef: HomeRecordReference;
    commitSequence: CommitSequence;
    type: "fallback";
  }>;

export type OpenedInitialBootstrapRoot = Readonly<{
  commit: FileSystemCommitPayload;
  rootDirectoryInode: DirectoryInodeEntry;
}>;

type EncryptedFrame = Readonly<{
  bytes: Uint8Array;
  header: RecordFrameHeaderV1;
  homeReference: HomeRecordReference;
}>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function freshRecordNonce({ randomSource, usedNonces }: {
  randomSource?: RandomByteSource;
  usedNonces: readonly Uint8Array[];
}): RecordNonce {
  for (let attempt = 0; attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts; attempt += 1) {
    const nonce = generateRecordNonce({ randomSource });
    if (!usedNonces.some(used => bytesEqual({ left: used, right: nonce }))) return nonce;
  }
  throw new Error("Record nonce generation exhausted the collision retry bound");
}

async function buildEncryptedFrame({
  diagnostics,
  fileSystemId,
  homeOffset,
  homeSegmentId,
  plaintext,
  randomSource,
  recordKind,
  rootKey,
  usedNonces,
}: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeOffset: bigint;
  homeSegmentId: SegmentId;
  plaintext: Uint8Array;
  randomSource?: RandomByteSource;
  recordKind: number;
  rootKey: FileSystemRootKey;
  usedNonces: Uint8Array[];
}): Promise<EncryptedFrame> {
  const nonce = freshRecordNonce({ randomSource, usedNonces });
  usedNonces.push(Uint8Array.from(nonce));
  const header = createRecordFrameHeader({
    flags: 0,
    homeOffset: createUInt64({ value: homeOffset }),
    homeSegmentId,
    nonce,
    plaintextLength: plaintext.byteLength,
    recordKind,
  });
  const completeFrameHeader = encodeRecordFrameHeader({ header });
  const ciphertext = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await encryptRecord({
      completeFrameHeader,
      fileSystemId,
      homeSegmentId,
      nonce,
      plaintext: plaintextRecordBytes({ bytes: plaintext }),
      rootKey,
    }),
  });
  const bytes = new Uint8Array(header.frameLength);
  bytes.set(completeFrameHeader, 0);
  bytes.set(ciphertext, completeFrameHeader.byteLength);
  return {
    bytes,
    header,
    homeReference: createHomeRecordReference({ fields: {
      byteOffset: header.homeOffset,
      frameLength: header.frameLength,
      recordKind: header.recordKind,
      segmentId: homeSegmentId,
    } }),
  };
}

async function ensureMetadataSegmentDirectories({ backend, segmentId }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  segmentId: SegmentId;
}): Promise<void> {
  const segmentDirectory = canonicalContainerDirectory({
    value: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName,
  });
  const metadataDirectory = canonicalContainerDirectory({
    value: `${segmentDirectory}/${HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClassDirectories.metadata}`,
  });
  const shardDirectory = canonicalContainerDirectory({
    value: `${metadataDirectory}/${segmentIdToShard({ id: segmentId })}`,
  });
  await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path: shardDirectory });
}

async function createAuthenticatedSegmentHeader({ diagnostics, fileSystemId, physicalSegmentId, rootKey }: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
}): Promise<Uint8Array> {
  const skeleton = encodeSegmentHeader({ header: {
    authenticationTag: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes),
    physicalSegmentId,
    segmentClass: "metadata",
  } });
  const prefix = segmentHeaderAuthenticatedPrefix({ bytes: skeleton });
  const authenticationTag = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await encryptSegmentHeader({
      fileSystemId,
      physicalSegmentId,
      plaintext: plaintextSegmentHeaderBytes({ bytes: new Uint8Array() }),
      rootKey,
      segmentClass: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClasses.metadata,
      segmentHeaderPrefix: prefix,
    }),
  });
  if (authenticationTag.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes) {
    throw new Error("zero-length Segment Header authentication must produce exactly one tag");
  }
  return encodeSegmentHeader({ header: {
    authenticationTag,
    physicalSegmentId,
    segmentClass: "metadata",
  } });
}

function concatenate({ chunks, totalLength }: {
  chunks: readonly Uint8Array[];
  totalLength: number;
}): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function createInitialBootstrapSegment({ backend, diagnostics, fileSystemId, randomSource, rootKey }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
}): Promise<InitialBootstrapAuthority> {
  const physicalSegmentId = await generateSegmentId({
    isUsed: async ({ id }) => await segmentIdIsUsedAcrossClasses({ backend, segmentId: id }),
    randomSource,
  });
  const activeMutationId = await generateMutationId({ isUsed: async () => false, randomSource });
  const activeCommitSequence = createCommitSequence({ value: 1n });
  const usedNonces: Uint8Array[] = [];
  const segmentHeader = await createAuthenticatedSegmentHeader({ diagnostics, fileSystemId, physicalSegmentId, rootKey });
  const inodeTableFrame = await buildEncryptedFrame({
    diagnostics,
    fileSystemId,
    homeOffset: BigInt(segmentHeader.byteLength),
    homeSegmentId: physicalSegmentId,
    plaintext: measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "encode",
      run: () => encodeInodeLeafPage({
        entries: [{
          content: { entries: [], type: "inline" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: { createdAt: null, modifiedAt: null },
        }],
        isRoot: true,
      }),
    }),
    randomSource,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    rootKey,
    usedNonces,
  });
  const commitPayload = createFileSystemCommitPayload({ payload: {
    commitSequence: activeCommitSequence,
    mutationId: activeMutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: inodeTableFrame.homeReference,
  } });
  const commitFrame = await buildEncryptedFrame({
    diagnostics,
    fileSystemId,
    homeOffset: BigInt(segmentHeader.byteLength + inodeTableFrame.bytes.byteLength),
    homeSegmentId: physicalSegmentId,
    plaintext: measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "encode",
      run: () => encodeFileSystemCommitPayload({ payload: commitPayload }),
    }),
    randomSource,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    rootKey,
    usedNonces,
  });
  const segmentBytes = concatenate({
    chunks: [segmentHeader, inodeTableFrame.bytes, commitFrame.bytes],
    totalLength: segmentHeader.byteLength + inodeTableFrame.bytes.byteLength + commitFrame.bytes.byteLength,
  });
  await ensureMetadataSegmentDirectories({ backend, segmentId: physicalSegmentId });
  await createAuthenticatedWholeFile({
    backend,
    bytes: authenticatedHizoFSPhysicalBytes({ bytes: segmentBytes }),
    path: authenticatedSegmentPath({ segmentClass: "metadata", segmentId: physicalSegmentId }),
  });
  for (const frame of [inodeTableFrame, commitFrame]) {
    diagnostics?.recordPersistedRecord({
      operation: "write",
      physicalBytes: frame.bytes.byteLength,
      plaintextBytes: frame.header.plaintextLength,
      recordKind: frame.header.recordKind,
    });
  }
  const authority = {
    activeCommitHomeRef: commitFrame.homeReference,
    activeCommitSequence,
    activeMutationId,
  };
  await readInitialBootstrapRoot({ ...authority, backend, diagnostics, fileSystemId, rootKey });
  return authority;
}

export async function readBootstrapRoot({
  authority,
  backend,
  diagnostics,
  fileSystemId,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  authority: BootstrapCommitAuthority;
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<OpenedInitialBootstrapRoot> {
  if (authority.commitHomeRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Commit reference has the wrong record kind",
    });
  }
  const commitRecord = await resolveAuthenticatedHomeRecord({
    backend,
    diagnostics,
    fileSystemId,
    homeReference: authority.commitHomeRef,
    relocationIndexRootPhysicalRef,
    rootKey,
  });
  let commit: FileSystemCommitPayload;
  try {
    commit = measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => decodeFileSystemCommitPayload({ bytes: commitRecord.plaintext }),
    });
    switch (authority.type) {
    case "active":
      validateActiveCommitAuthority({
        activeCommitSequence: authority.commitSequence,
        activeMutationId: authority.mutationId,
        commit,
      });
      break;
    case "fallback":
      if (commit.commitSequence !== authority.commitSequence) {
        throw new TypeError("fallback Commit Sequence does not match its explicit authority");
      }
      break;
    default:
      authority satisfies never;
    }
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Commit payload or authority validation failed",
    });
  } finally {
    commitRecord.plaintext.fill(0);
  }
  let rootEntry: InodeLeafEntry | undefined;
  try {
    const visited = new Set<string>();
    let reference = commit.rootInodeTableRootHomeRef;
    let isRoot = true;
    let expectedLevel: number | undefined;
    let expectedUpperBound: InodeNumber | undefined;
    for (;;) {
      const identity = runtimeHomeRecordReferenceIdentity({ reference });
      if (visited.has(identity)) throw new TypeError("root Inode Table contains a cycle");
      visited.add(identity);
      const page = await readAuthenticatedInodeTablePage({
        backend,
        diagnostics,
        fileSystemId,
        homeReference: reference,
        isRoot,
        relocationIndexRootPhysicalRef,
        rootKey,
      });
      if (expectedLevel !== undefined && page.level !== expectedLevel) {
        throw new TypeError("root Inode Table child level does not equal parent level minus one");
      }
      let pageMaximum: InodeNumber | undefined;
      switch (page.type) {
      case "leaf": pageMaximum = page.entries.at(-1)?.inodeNumber; break;
      case "branch": pageMaximum = page.entries.at(-1)?.upperBound; break;
      default: page satisfies never;
      }
      if (expectedUpperBound !== undefined && pageMaximum !== expectedUpperBound) {
        throw new TypeError("root Inode Table child upper bound does not match its subtree maximum");
      }
      switch (page.type) {
      case "leaf": {
        let low = 0;
        let high = page.entries.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          const middleEntry = page.entries[middle];
          if (middleEntry === undefined) throw new Error("Inode Table leaf binary-search invariant failed");
          if (middleEntry.inodeNumber < commit.rootDirectoryInodeNumber) low = middle + 1;
          else high = middle;
        }
        const candidate = page.entries[low];
        rootEntry = candidate?.inodeNumber === commit.rootDirectoryInodeNumber ? candidate : undefined;
        break;
      }
      case "branch": {
        let low = 0;
        let high = page.entries.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          const middleEntry = page.entries[middle];
          if (middleEntry === undefined) throw new Error("Inode Table branch binary-search invariant failed");
          if (middleEntry.upperBound < commit.rootDirectoryInodeNumber) low = middle + 1;
          else high = middle;
        }
        const child = page.entries[low];
        if (child === undefined) {
          rootEntry = undefined;
          break;
        }
        reference = child.childPageHomeRef;
        isRoot = false;
        expectedLevel = page.level - 1;
        expectedUpperBound = child.upperBound;
        continue;
      }
      default: page satisfies never;
      }
      break;
    }
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "root Inode Table traversal failed",
    });
  }
  if (rootEntry === undefined || rootEntry.inodeKind !== "directory") {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Commit does not resolve to a root directory inode",
    });
  }
  return { commit, rootDirectoryInode: rootEntry };
}

export async function readInitialBootstrapRoot({
  activeCommitHomeRef,
  activeCommitSequence,
  activeMutationId,
  backend,
  diagnostics,
  fileSystemId,
  rootKey,
}: InitialBootstrapAuthority & {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
}): Promise<OpenedInitialBootstrapRoot> {
  return await readBootstrapRoot({
    authority: {
      commitHomeRef: activeCommitHomeRef,
      commitSequence: activeCommitSequence,
      mutationId: activeMutationId,
      type: "active",
    },
    backend,
    diagnostics,
    fileSystemId,
    relocationIndexRootPhysicalRef: null,
    rootKey,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
