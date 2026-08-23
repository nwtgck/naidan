import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createUnlockSequence,
  decodeBase64UrlUnpadded,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  decodeUnlockEnvelope,
  encodeUnlockEnvelope,
  parseSegmentFilename,
  segmentIdToLowercaseHex,
  segmentIdToShard,
  type FeatureBits,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RecordFrameHeaderV1,
  type SegmentClass,
  type SegmentFooterHeaderV1,
  type SegmentFooterIndexEntryV1,
  type SegmentFooterTrailerV1,
  type SegmentHeaderV1,
  type SegmentId,
  type SuperblockHeaderV1,
  type SuperblockPlaintextV1,
  type UnlockEnvelopeV1,
} from "@/00-storage/service/hizofs/00-format";
import { AuthenticatedStoreError } from "@/00-storage/service/hizofs/authenticated-store/errors";
import type {
  AuthenticatedHizoFSInspectionPort,
  HizoFSInspectionPhysicalEntry,
} from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import {
  authenticatedSuperblockBytes,
  decryptAuthenticatedSuperblock,
  isHizoFSCryptoAuthenticationError,
  superblockNonce,
  unlockAuthenticatorNonce,
  unlockAuthenticatorTag,
  verifyUnlockAuthenticator,
  type FileSystemRootKey,
} from "@/00-storage/service/hizofs/01-crypto";

export type HizoFSInspectionCopyState =
  | "missing"
  | "proof_invalid"
  | "proof_unresolved"
  | "proof_valid"
  | "structurally_invalid";

export type HizoFSRecordReferenceInspection = Readonly<{
  byteOffset: string;
  frameLength: number;
  recordKind: number;
  segmentId: string;
}>;

/**
 * These DTOs back a developer/reviewer audit tool. A structurally decoded
 * persisted DTO is retained verbatim so new format fields cannot disappear
 * behind a summary projection. Wrapped keys, nonces, and authentication tags
 * are persisted ciphertext/proof material and are intentionally observable;
 * passphrases and unwrapped root-key capabilities must never enter this result.
 */
export type HizoFSUnlockEnvelopeCopyInspection = Readonly<{
  copy: 0 | 1;
  envelope: UnlockEnvelopeV1 | undefined;
  credentialSlotCount: number | undefined;
  fileSystemId: string | undefined;
  path: string;
  reason: string | undefined;
  selected: boolean;
  sequence: string | undefined;
  state: HizoFSInspectionCopyState;
}>;

export type HizoFSSuperblockCopyInspection = Readonly<{
  activeCommit: HizoFSRecordReferenceInspection | undefined;
  activeCommitSequence: string | undefined;
  fallbackCommit: HizoFSRecordReferenceInspection | undefined;
  copy: 0 | 1;
  header: SuperblockHeaderV1 | undefined;
  minimumUnlockSequence: string | undefined;
  path: string;
  plaintext: SuperblockPlaintextV1 | undefined;
  publicationSequence: string | undefined;
  relocationIndexRoot: HizoFSRecordReferenceInspection | undefined;
  reason: string | undefined;
  requiredFeatureBits: string | undefined;
  selected: boolean;
  state: Exclude<HizoFSInspectionCopyState, "proof_unresolved">;
}>;

export type HizoFSSegmentFrameInspection = Readonly<{
  flags: number;
  frameLength: number;
  homeReference: HizoFSRecordReferenceInspection | undefined;
  homeOffset: string;
  homeSegmentId: string;
  header: RecordFrameHeaderV1;
  physicalOffset: string;
  plaintextLength: number;
  recordKind: number;
}>;

export type HizoFSSegmentInspection = Readonly<{
  fileSize: string | undefined;
  footerHeader: SegmentFooterHeaderV1 | undefined;
  footerIndexEntries: readonly SegmentFooterIndexEntryV1[] | undefined;
  footerPhysicalOffset: string | undefined;
  footerTotalLength: number | undefined;
  footerTrailer: SegmentFooterTrailerV1 | undefined;
  frames: readonly HizoFSSegmentFrameInspection[];
  header: SegmentHeaderV1 | undefined;
  path: string;
  physicalSegmentId: string | undefined;
  reason: string | undefined;
  segmentClass: SegmentClass;
  state: "invalid" | "sealed" | "unsealed_complete" | "unsealed_incomplete" | "unknown_physical_entry";
}>;

export type HizoFSAuthoritySelectionInspection =
  | Readonly<{
      copy: 0 | 1;
      redundancy: "degraded" | "normal";
      sequence: string;
      state: "selected";
    }>
  | Readonly<{
      code: string;
      message: string;
      state: "rejected";
    }>;

export type HizoFSRootDirectoryShortcutInspection =
  | Readonly<{
      activeCommit: HizoFSRecordReferenceInspection;
      commitSequence: string;
      mode: "active";
      nestedSubvolumeTableRoot: HizoFSRecordReferenceInspection | undefined;
      rootDirectoryInodeNumber: string;
      rootInodeTableRoot: HizoFSRecordReferenceInspection;
      state: "available";
    }>
  | Readonly<{
      activeCommit: HizoFSRecordReferenceInspection;
      activeFailureReason: string;
      commitSequence: string;
      mode: "fallback_read_only";
      nestedSubvolumeTableRoot: HizoFSRecordReferenceInspection | undefined;
      rootDirectoryInodeNumber: string;
      rootInodeTableRoot: HizoFSRecordReferenceInspection;
      state: "available";
    }>
  | Readonly<{
      reason: string;
      state: "unavailable";
    }>;

export type HizoFSPhysicalContainerInspection = Readonly<{
  physicalAnomalies: readonly string[];
  rootDirectoryShortcut: HizoFSRootDirectoryShortcutInspection | undefined;
  segments: readonly HizoFSSegmentInspection[];
  superblockCopies: readonly HizoFSSuperblockCopyInspection[];
  superblockSelection: HizoFSAuthoritySelectionInspection | undefined;
  unlockEnvelopeCopies: readonly HizoFSUnlockEnvelopeCopyInspection[];
  unlockSelection: HizoFSAuthoritySelectionInspection;
}>;

type StructuralUnlockCopy = Readonly<{
  copy: 0 | 1;
  envelope: UnlockEnvelopeV1;
}>;

type StructuralUnlockInspection = Readonly<{
  copies: readonly HizoFSUnlockEnvelopeCopyInspection[];
  structural: readonly StructuralUnlockCopy[];
}>;

type OpenedUnlockCopies = Awaited<ReturnType<AuthenticatedHizoFSInspectionPort["openUnlockCopies"]>>;
type OpenedSuperblockCopies = Awaited<ReturnType<AuthenticatedHizoFSInspectionPort["openSuperblockCopies"]>>;
type SegmentIndexState = Awaited<ReturnType<AuthenticatedHizoFSInspectionPort["readSegmentIndex"]>>["state"];

function reasonFrom({ cause }: { cause: unknown }): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function rejectionFrom({ cause }: { cause: unknown }): Extract<HizoFSAuthoritySelectionInspection, { state: "rejected" }> {
  return {
    code: cause instanceof AuthenticatedStoreError ? cause.code : "inspection_failed",
    message: reasonFrom({ cause }),
    state: "rejected",
  };
}

function referenceInspection({ reference }: { reference: HomeRecordReference | PhysicalRecordReference }): HizoFSRecordReferenceInspection {
  return {
    byteOffset: String(reference.byteOffset),
    frameLength: reference.frameLength,
    recordKind: reference.recordKind,
    segmentId: segmentIdToLowercaseHex({ id: reference.segmentId }),
  };
}

function credentialRedundancy({ copyState }: { copyState: OpenedUnlockCopies["copyState"] }): "degraded" | "normal" {
  switch (copyState) {
  case "credential_redundancy_degraded": return "degraded";
  case "normal": return "normal";
  default: return copyState satisfies never;
  }
}

function superblockRedundancy({ copyState }: { copyState: OpenedSuperblockCopies["copyState"] }): "degraded" | "normal" {
  switch (copyState) {
  case "superblock_redundancy_degraded": return "degraded";
  case "normal": return "normal";
  default: return copyState satisfies never;
  }
}

async function readStructuralUnlockCopies({ physical }: {
  physical: AuthenticatedHizoFSInspectionPort;
}): Promise<StructuralUnlockInspection> {
  const copies: HizoFSUnlockEnvelopeCopyInspection[] = [];
  const structural: StructuralUnlockCopy[] = [];
  for (const copy of [0, 1] as const) {
    const path = HIZOFS_UNLOCK_ENVELOPE_FILES[copy];
    try {
      const bytes = await physical.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes,
        path,
      });
      if (bytes === undefined) {
        copies.push({
          copy,
          credentialSlotCount: undefined,
          envelope: undefined,
          fileSystemId: undefined,
          path,
          reason: "missing",
          selected: false,
          sequence: undefined,
          state: "missing",
        });
        continue;
      }
      const envelope = decodeUnlockEnvelope({ bytes });
      if (envelope.copy !== copy) throw new TypeError("Unlock Envelope copy field does not match its physical path");
      structural.push({ copy, envelope });
      copies.push({
        copy,
        credentialSlotCount: envelope.credentialSlots.length,
        envelope,
        fileSystemId: envelope.fileSystemId,
        path,
        reason: undefined,
        selected: false,
        sequence: String(envelope.sequence),
        state: "proof_unresolved",
      });
    } catch (cause: unknown) {
      copies.push({
        copy,
        credentialSlotCount: undefined,
        envelope: undefined,
        fileSystemId: undefined,
        path,
        reason: reasonFrom({ cause }),
        selected: false,
        sequence: undefined,
        state: "structurally_invalid",
      });
    }
  }
  return { copies, structural };
}

async function verifyUnlockCopy({ envelope, rootKey }: {
  envelope: UnlockEnvelopeV1;
  rootKey: FileSystemRootKey;
}): Promise<boolean> {
  try {
    await verifyUnlockAuthenticator({
      canonicalUnsignedEnvelopeBytes: encodeUnlockEnvelope({ envelope, includeAuthenticatorTag: false }),
      copy: envelope.copy,
      fileSystemId: envelope.fileSystemId,
      nonce: unlockAuthenticatorNonce({
        bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 12, value: envelope.authenticatorNonce }),
      }),
      rootKey,
      tag: unlockAuthenticatorTag({
        bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 16, value: envelope.authenticatorTag }),
      }),
      unlockSequence: createUnlockSequence({ value: BigInt(envelope.sequence) }),
    });
    return true;
  } catch (cause: unknown) {
    if (isHizoFSCryptoAuthenticationError({ cause })) return false;
    throw cause;
  }
}

async function classifiedUnlockCopies({
  rootKey,
  selectedCopy,
  structural,
  unresolved,
}: {
  rootKey: FileSystemRootKey;
  selectedCopy: 0 | 1;
  structural: readonly StructuralUnlockCopy[];
  unresolved: readonly HizoFSUnlockEnvelopeCopyInspection[];
}): Promise<readonly HizoFSUnlockEnvelopeCopyInspection[]> {
  const byCopy = new Map(structural.map(candidate => [candidate.copy, candidate] as const));
  const result: HizoFSUnlockEnvelopeCopyInspection[] = [];
  for (const copyInspection of unresolved) {
    const candidate = byCopy.get(copyInspection.copy);
    if (candidate === undefined) {
      result.push(copyInspection);
      continue;
    }
    const valid = await verifyUnlockCopy({ envelope: candidate.envelope, rootKey });
    result.push({
      ...copyInspection,
      reason: valid ? undefined : "Unlock Envelope authenticator verification failed",
      selected: valid && copyInspection.copy === selectedCopy,
      state: valid ? "proof_valid" : "proof_invalid",
    });
  }
  return result;
}

async function inspectSuperblockCopies({ fileSystemId, physical, rootKey, selectedCopy }: {
  fileSystemId: FileSystemId;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
  selectedCopy: 0 | 1 | undefined;
}): Promise<readonly HizoFSSuperblockCopyInspection[]> {
  const result: HizoFSSuperblockCopyInspection[] = [];
  for (const copy of [0, 1] as const) {
    const path = HIZOFS_SUPERBLOCK_FILES[copy];
    let decodedHeader: SuperblockHeaderV1 | undefined;
    const base = {
      activeCommit: undefined,
      activeCommitSequence: undefined,
      fallbackCommit: undefined,
      copy,
      header: undefined,
      minimumUnlockSequence: undefined,
      path,
      plaintext: undefined,
      publicationSequence: undefined,
      relocationIndexRoot: undefined,
      requiredFeatureBits: undefined,
      selected: false,
    } as const;
    try {
      const bytes = await physical.readFileBounded({
        maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
        path,
      });
      if (bytes === undefined) {
        result.push({ ...base, reason: "missing", state: "missing" });
        continue;
      }
      if (bytes.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile) {
        throw new RangeError("Superblock file length is invalid");
      }
      const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
      const exactHeader = bytes.subarray(0, headerSize);
      const header = decodeSuperblockHeader({ bytes: exactHeader });
      decodedHeader = header;
      if (header.copy !== copy) throw new TypeError("Superblock copy field does not match its physical path");
      if (header.fileSystemId !== fileSystemId) {
        throw new TypeError("Superblock File System ID does not match the unlocked container");
      }
      const structuralBase = {
        ...base,
        activeCommitSequence: String(header.activeCommitSequence),
        header,
        publicationSequence: String(header.publicationSequence),
      } as const;
      let plaintextBytes: Uint8Array;
      try {
        plaintextBytes = await decryptAuthenticatedSuperblock({
          ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
          copy,
          exactHeader,
          fileSystemId,
          nonce: superblockNonce({ bytes: header.nonce }),
          publicationSequence: header.publicationSequence,
          rootKey,
        });
      } catch (cause: unknown) {
        if (isHizoFSCryptoAuthenticationError({ cause })) {
          result.push({
            ...structuralBase,
            reason: "Superblock authentication failed",
            state: "proof_invalid",
          });
          continue;
        }
        throw cause;
      }
      try {
        const plaintext = decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags });
        result.push({
          ...structuralBase,
          activeCommit: referenceInspection({ reference: plaintext.activeCommitHomeRef }),
          fallbackCommit: plaintext.fallbackCommitHomeRef === null
            ? undefined
            : referenceInspection({ reference: plaintext.fallbackCommitHomeRef }),
          minimumUnlockSequence: String(plaintext.minimumUnlockSequence),
          plaintext,
          relocationIndexRoot: plaintext.relocationIndexRootPhysicalRef === null
            ? undefined
            : referenceInspection({ reference: plaintext.relocationIndexRootPhysicalRef }),
          reason: undefined,
          requiredFeatureBits: String(plaintext.requiredFeatureBits),
          selected: copy === selectedCopy,
          state: "proof_valid",
        });
      } finally {
        plaintextBytes.fill(0);
      }
    } catch (cause: unknown) {
      result.push({
        ...base,
        ...(decodedHeader === undefined
          ? {}
          : {
            activeCommitSequence: String(decodedHeader.activeCommitSequence),
            header: decodedHeader,
            publicationSequence: String(decodedHeader.publicationSequence),
          }),
        reason: reasonFrom({ cause }),
        state: "structurally_invalid",
      });
    }
  }
  return result;
}

function segmentClassDirectory({ segmentClass }: { segmentClass: SegmentClass }): string {
  return `${HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName}/${HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClassDirectories[segmentClass]}`;
}

function checkedEntries({ entries, label, maximum }: {
  entries: readonly HizoFSInspectionPhysicalEntry[];
  label: string;
  maximum: number;
}): readonly HizoFSInspectionPhysicalEntry[] {
  if (entries.length > maximum) throw new RangeError(`${label} exceeds the Inspector entry bound`);
  return entries;
}

function entryName({ entry }: { entry: HizoFSInspectionPhysicalEntry }): string {
  switch (entry.kind) {
  case "directory": return entry.name;
  case "file": return entry.name;
  default: return entry satisfies never;
  }
}

function segmentState({ state }: { state: SegmentIndexState }): HizoFSSegmentInspection["state"] {
  switch (state) {
  case "sealed": return "sealed";
  case "complete_unsealed": return "unsealed_complete";
  case "abandoned_unsealed":
  case "footer_unusable":
    return "unsealed_incomplete";
  default: return state satisfies never;
  }
}

function segmentReason({ state }: { state: SegmentIndexState }): string | undefined {
  switch (state) {
  case "footer_unusable": return "Segment Footer is unusable; valid prefix retained";
  case "abandoned_unsealed":
  case "complete_unsealed":
  case "sealed":
    return undefined;
  default: return state satisfies never;
  }
}

class InspectionFrameBudgetExceededError extends RangeError {
  constructor() {
    super("physical frame count exceeds the Inspector bound");
    this.name = "InspectionFrameBudgetExceededError";
  }
}

async function listPhysicalSegments({ fileSystemId, maximumFrames, maximumSegments, physical, rootKey }: {
  fileSystemId: FileSystemId;
  maximumFrames: number;
  maximumSegments: number;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
}): Promise<Readonly<{ anomalies: readonly string[]; segments: readonly HizoFSSegmentInspection[] }>> {
  if (!Number.isSafeInteger(maximumFrames) || maximumFrames < 1) {
    throw new RangeError("maximumFrames must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumSegments) || maximumSegments < 1) {
    throw new RangeError("maximumSegments must be a positive safe integer");
  }
  let frameCount = 0;
  const anomalies: string[] = [];
  const segments: HizoFSSegmentInspection[] = [];
  for (const segmentClass of ["metadata", "data"] as const) {
    const classDirectory = segmentClassDirectory({ segmentClass });
    let shardEntries: readonly HizoFSInspectionPhysicalEntry[];
    try {
      shardEntries = checkedEntries({
        entries: await physical.list({ directory: classDirectory }),
        label: `${segmentClass} segment class directory`,
        maximum: 256,
      });
    } catch (cause: unknown) {
      anomalies.push(`${classDirectory}: ${reasonFrom({ cause })}`);
      continue;
    }
    for (const shardEntry of shardEntries) {
      const shardName = entryName({ entry: shardEntry });
      switch (shardEntry.kind) {
      case "directory":
        if (!/^[0-9a-f]{2}$/u.test(shardEntry.name)) {
          anomalies.push(`${classDirectory}/${shardEntry.name}: unexpected physical entry`);
          continue;
        }
        break;
      case "file":
        anomalies.push(`${classDirectory}/${shardEntry.name}: unexpected physical entry`);
        continue;
      default:
          shardEntry satisfies never;
      }
      const shardDirectory = `${classDirectory}/${shardName}`;
      let fileEntries: readonly HizoFSInspectionPhysicalEntry[];
      try {
        fileEntries = checkedEntries({
          entries: await physical.list({ directory: shardDirectory }),
          label: `${segmentClass} segment shard directory`,
          maximum: maximumSegments,
        });
      } catch (cause: unknown) {
        anomalies.push(`${shardDirectory}: ${reasonFrom({ cause })}`);
        continue;
      }
      for (const entry of fileEntries) {
        if (segments.length >= maximumSegments) {
          throw new RangeError("physical segment count exceeds the Inspector bound");
        }
        const name = entryName({ entry });
        const path = `${shardDirectory}/${name}`;
        switch (entry.kind) {
        case "directory":
          segments.push({
            fileSize: undefined,
            footerHeader: undefined,
            footerIndexEntries: undefined,
            footerPhysicalOffset: undefined,
            footerTotalLength: undefined,
            footerTrailer: undefined,
            frames: [],
            header: undefined,
            path,
            physicalSegmentId: undefined,
            reason: "segment shard entry is not a file",
            segmentClass,
            state: "unknown_physical_entry",
          });
          continue;
        case "file":
          break;
        default:
            entry satisfies never;
        }
        let segmentId: SegmentId;
        try {
          segmentId = parseSegmentFilename({ value: entry.name });
          if (segmentIdToShard({ id: segmentId }) !== shardName) {
            throw new TypeError("segment filename does not match its shard directory");
          }
        } catch (cause: unknown) {
          segments.push({
            fileSize: String(entry.byteLength),
            footerHeader: undefined,
            footerIndexEntries: undefined,
            footerPhysicalOffset: undefined,
            footerTotalLength: undefined,
            footerTrailer: undefined,
            frames: [],
            header: undefined,
            path,
            physicalSegmentId: undefined,
            reason: reasonFrom({ cause }),
            segmentClass,
            state: "unknown_physical_entry",
          });
          continue;
        }
        try {
          const index = await physical.readSegmentIndex({
            fileSystemId,
            physicalSegmentId: segmentId,
            rootKey,
            segmentClass,
          });
          if (index.frames.length > maximumFrames - frameCount) {
            throw new InspectionFrameBudgetExceededError();
          }
          frameCount += index.frames.length;
          segments.push({
            fileSize: String(entry.byteLength),
            footerHeader: index.footer?.header,
            footerIndexEntries: index.footer?.indexEntries,
            footerPhysicalOffset: index.footer === undefined ? undefined : String(index.footer.physicalOffset),
            footerTotalLength: index.footer?.totalLength,
            footerTrailer: index.footer?.trailer,
            frames: index.frames.map(frame => ({
              flags: frame.header.flags,
              frameLength: frame.header.frameLength,
              homeReference: frame.header.flags === HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly
                ? undefined
                : {
                  byteOffset: String(frame.header.homeOffset),
                  frameLength: frame.header.frameLength,
                  recordKind: frame.header.recordKind,
                  segmentId: segmentIdToLowercaseHex({ id: frame.header.homeSegmentId }),
                },
              homeOffset: String(frame.header.homeOffset),
              homeSegmentId: segmentIdToLowercaseHex({ id: frame.header.homeSegmentId }),
              header: frame.header,
              physicalOffset: String(frame.physicalOffset),
              plaintextLength: frame.header.plaintextLength,
              recordKind: frame.header.recordKind,
            })),
            header: index.header,
            path,
            physicalSegmentId: segmentIdToLowercaseHex({ id: segmentId }),
            reason: segmentReason({ state: index.state }),
            segmentClass,
            state: segmentState({ state: index.state }),
          });
        } catch (cause: unknown) {
          if (cause instanceof InspectionFrameBudgetExceededError) throw cause;
          segments.push({
            fileSize: String(entry.byteLength),
            footerHeader: undefined,
            footerIndexEntries: undefined,
            footerPhysicalOffset: undefined,
            footerTotalLength: undefined,
            footerTrailer: undefined,
            frames: [],
            header: undefined,
            path,
            physicalSegmentId: segmentIdToLowercaseHex({ id: segmentId }),
            reason: reasonFrom({ cause }),
            segmentClass,
            state: "invalid",
          });
        }
      }
    }
  }
  return { anomalies, segments };
}

async function inspectRootShortcut({ fileSystemId, openedSuperblock, physical, rootKey }: {
  fileSystemId: FileSystemId;
  openedSuperblock: OpenedSuperblockCopies;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
}): Promise<HizoFSRootDirectoryShortcutInspection> {
  try {
    const opened = await physical.readBootstrapRoot({
      authority: {
        commitHomeRef: openedSuperblock.logicalState.activeCommitHomeRef,
        commitSequence: openedSuperblock.logicalState.activeCommitSequence,
        mutationId: openedSuperblock.logicalState.activeMutationId,
        type: "active",
      },
      fileSystemId,
      relocationIndexRootPhysicalRef: openedSuperblock.logicalState.relocationIndexRootPhysicalRef,
      rootKey,
    });
    return {
      activeCommit: referenceInspection({ reference: openedSuperblock.logicalState.activeCommitHomeRef }),
      commitSequence: String(opened.commit.commitSequence),
      mode: "active",
      nestedSubvolumeTableRoot: opened.commit.nestedSubvolumeTableRootHomeRef === null
        ? undefined
        : referenceInspection({ reference: opened.commit.nestedSubvolumeTableRootHomeRef }),
      rootDirectoryInodeNumber: String(opened.commit.rootDirectoryInodeNumber),
      rootInodeTableRoot: referenceInspection({ reference: opened.commit.rootInodeTableRootHomeRef }),
      state: "available",
    };
  } catch (activeCause: unknown) {
    const fallback = openedSuperblock.logicalState.fallbackCommitHomeRef;
    if (fallback === null) return { reason: reasonFrom({ cause: activeCause }), state: "unavailable" };
    try {
      const opened = await physical.readBootstrapRoot({
        authority: {
          commitHomeRef: fallback,
          commitSequence: createCommitSequence({ value: openedSuperblock.logicalState.activeCommitSequence - 1n }),
          type: "fallback",
        },
        fileSystemId,
        relocationIndexRootPhysicalRef: openedSuperblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      });
      return {
        activeCommit: referenceInspection({ reference: fallback }),
        activeFailureReason: reasonFrom({ cause: activeCause }),
        commitSequence: String(opened.commit.commitSequence),
        mode: "fallback_read_only",
        nestedSubvolumeTableRoot: opened.commit.nestedSubvolumeTableRootHomeRef === null
          ? undefined
          : referenceInspection({ reference: opened.commit.nestedSubvolumeTableRootHomeRef }),
        rootDirectoryInodeNumber: String(opened.commit.rootDirectoryInodeNumber),
        rootInodeTableRoot: referenceInspection({ reference: opened.commit.rootInodeTableRootHomeRef }),
        state: "available",
      };
    } catch (fallbackCause: unknown) {
      return {
        reason: `active: ${reasonFrom({ cause: activeCause })}; fallback: ${reasonFrom({ cause: fallbackCause })}`,
        state: "unavailable",
      };
    }
  }
}

async function inspectHizoFSPhysicalContainerWithOpenedAuthority({
  fileSystemId,
  maximumFrames,
  maximumSegments,
  physical,
  rootKey,
  structuralUnlock,
  supportedFeatureBits,
}: {
  fileSystemId: FileSystemId;
  maximumFrames: number;
  maximumSegments: number;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
  structuralUnlock: StructuralUnlockInspection;
  supportedFeatureBits: FeatureBits;
}): Promise<HizoFSPhysicalContainerInspection> {
  let openedSuperblock: OpenedSuperblockCopies;
  try {
    openedSuperblock = await physical.openSuperblockCopies({
      fileSystemId,
      rootKey,
      supportedFeatureBits,
    });
  } catch (cause: unknown) {
    const authority = await physical.openUnlockAuthority({
      fileSystemId,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      rootKey,
    });
    return {
      physicalAnomalies: [],
      rootDirectoryShortcut: undefined,
      segments: [],
      superblockCopies: await inspectSuperblockCopies({
        fileSystemId,
        physical,
        rootKey,
        selectedCopy: undefined,
      }),
      superblockSelection: rejectionFrom({ cause }),
      unlockEnvelopeCopies: await classifiedUnlockCopies({
        rootKey,
        selectedCopy: authority.selectedPhysicalCopy,
        structural: structuralUnlock.structural,
        unresolved: structuralUnlock.copies,
      }),
      unlockSelection: {
        copy: authority.selectedPhysicalCopy,
        redundancy: credentialRedundancy({ copyState: authority.copyState }),
        sequence: String(authority.unlockSequence),
        state: "selected",
      },
    };
  }

  const unlockAuthority = await physical.openUnlockAuthority({
    fileSystemId,
    minimumUnlockSequence: openedSuperblock.logicalState.minimumUnlockSequence,
    rootKey,
  });
  const unlockEnvelopeCopies = await classifiedUnlockCopies({
    rootKey,
    selectedCopy: unlockAuthority.selectedPhysicalCopy,
    structural: structuralUnlock.structural,
    unresolved: structuralUnlock.copies,
  });
  const superblockCopies = await inspectSuperblockCopies({
    fileSystemId,
    physical,
    rootKey,
    selectedCopy: openedSuperblock.selectedCopy,
  });
  const rootDirectoryShortcut = await inspectRootShortcut({
    fileSystemId,
    openedSuperblock,
    physical,
    rootKey,
  });
  const physicalSegments = await listPhysicalSegments({
    fileSystemId,
    maximumFrames,
    maximumSegments,
    physical,
    rootKey,
  });
  return {
    physicalAnomalies: physicalSegments.anomalies,
    rootDirectoryShortcut,
    segments: physicalSegments.segments,
    superblockCopies,
    superblockSelection: {
      copy: openedSuperblock.selectedCopy,
      redundancy: superblockRedundancy({ copyState: openedSuperblock.copyState }),
      sequence: String(openedSuperblock.selectedPublicationSequence),
      state: "selected",
    },
    unlockEnvelopeCopies,
    unlockSelection: {
      copy: unlockAuthority.selectedPhysicalCopy,
      redundancy: credentialRedundancy({ copyState: unlockAuthority.copyState }),
      sequence: String(unlockAuthority.unlockSequence),
      state: "selected",
    },
  };
}

export async function inspectHizoFSPhysicalContainerWithAuthority({
  fileSystemId,
  maximumFrames = 65_536,
  maximumSegments = 4096,
  physical,
  rootKey,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  fileSystemId: FileSystemId;
  maximumFrames?: number;
  maximumSegments?: number;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
  supportedFeatureBits?: FeatureBits;
}): Promise<HizoFSPhysicalContainerInspection> {
  const structuralUnlock = await readStructuralUnlockCopies({ physical });
  return await inspectHizoFSPhysicalContainerWithOpenedAuthority({
    fileSystemId,
    maximumFrames,
    maximumSegments,
    physical,
    rootKey,
    structuralUnlock,
    supportedFeatureBits,
  });
}

export async function inspectHizoFSPhysicalContainer({
  maximumFrames = 65_536,
  maximumSegments = 4096,
  passphrase,
  physical,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  maximumFrames?: number;
  maximumSegments?: number;
  passphrase: string;
  physical: AuthenticatedHizoFSInspectionPort;
  supportedFeatureBits?: FeatureBits;
}): Promise<HizoFSPhysicalContainerInspection> {
  const structuralUnlock = await readStructuralUnlockCopies({ physical });
  let openedUnlock: OpenedUnlockCopies;
  try {
    openedUnlock = await physical.openUnlockCopies({
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase,
    });
  } catch (cause: unknown) {
    return {
      physicalAnomalies: [],
      rootDirectoryShortcut: undefined,
      segments: [],
      superblockCopies: [],
      superblockSelection: undefined,
      unlockEnvelopeCopies: structuralUnlock.copies,
      unlockSelection: rejectionFrom({ cause }),
    };
  }

  const rootKey = openedUnlock.rootKey;
  try {
    return await inspectHizoFSPhysicalContainerWithOpenedAuthority({
      fileSystemId: openedUnlock.fileSystemId,
      maximumFrames,
      maximumSegments,
      physical,
      rootKey,
      structuralUnlock,
      supportedFeatureBits,
    });
  } finally {
    rootKey.destroy();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
