import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeFileSystemCommitPayload,
  type FeatureBits,
  type FileSystemCommitPayload,
  type FileSystemId,
  type HomeRecordReference,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type {
  FileSystemRootKey,
  RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import type { AuthenticatedStoreDiagnosticsPort } from "./runtime-diagnostics-port";
import {
  createAuthenticatedSegmentWriter,
  encodedHizoFSRecord,
} from "./record-appender";
import {
  publishMutationSuperblockCopies,
  SuperblockMutationPublicationError,
  type OpenedSuperblockCopies,
  type SuperblockLogicalState,
  type SuperblockMutationPublicationFailureOutcome,
} from "./superblock-store";

export type PublishedPreparedMutationCommit = Readonly<{
  commitHomeRef: HomeRecordReference;
  superblock: OpenedSuperblockCopies;
}>;

/**
 * Carries the exact authenticated authority that may have crossed the first
 * durable Superblock write. Callers must resolve this state by rereading the
 * authoritative copies; retrying the mutation would risk duplicate effects.
 */
export class PreparedMutationCommitPublicationError extends Error {
  readonly commitHomeRef: HomeRecordReference;
  readonly commitPayload: FileSystemCommitPayload;
  readonly intendedLogicalState: SuperblockLogicalState;
  readonly outcome: SuperblockMutationPublicationFailureOutcome | undefined;

  constructor({
    cause,
    commitHomeRef,
    commitPayload,
    intendedLogicalState,
  }: {
    cause: unknown;
    commitHomeRef: HomeRecordReference;
    commitPayload: FileSystemCommitPayload;
    intendedLogicalState: SuperblockLogicalState;
  }) {
    super("prepared mutation Commit publication requires authoritative outcome resolution", { cause });
    this.name = "PreparedMutationCommitPublicationError";
    this.commitHomeRef = commitHomeRef;
    this.commitPayload = commitPayload;
    this.intendedLogicalState = intendedLogicalState;
    this.outcome = cause instanceof SuperblockMutationPublicationError ? cause.outcome : undefined;
  }
}

export async function appendAndPublishPreparedMutationCommit({
  backend,
  base,
  beforeFirstAuthorityWrite,
  commitPayload,
  diagnostics,
  fileSystemId,
  firstPublicationSequence,
  randomSource,
  rootKey,
  secondPublicationSequence,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite?: () => void;
  commitPayload: FileSystemCommitPayload;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<PublishedPreparedMutationCommit> {
  const writer = await createAuthenticatedSegmentWriter({
    backend,
    diagnostics,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass: "metadata",
  });
  try {
    const [appended] = await writer.append({ records: [encodedHizoFSRecord({
      plaintext: writer.encodeRecordPayload({ encode: () => encodeFileSystemCommitPayload({ payload: commitPayload }) }),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    })] });
    if (appended === undefined) throw new Error("Commit append result is missing");
    const commitHomeRef = (() => {
      switch (appended.type) {
      case "home": return appended.homeReference;
      case "physical_only": throw new Error("File System Commit cannot be a physical-only record");
      default: return appended satisfies never;
      }
    })();
    writer.abandon();
    const intendedLogicalState: SuperblockLogicalState = {
      ...base.logicalState,
      activeCommitHomeRef: commitHomeRef,
      activeCommitSequence: commitPayload.commitSequence,
      activeMutationId: commitPayload.mutationId,
      fallbackCommitHomeRef: base.logicalState.activeCommitHomeRef,
    };
    try {
      const superblock = await publishMutationSuperblockCopies({
        backend,
        base,
        beforeFirstAuthorityWrite,
        diagnostics,
        fileSystemId,
        firstPublicationSequence,
        logicalState: intendedLogicalState,
        randomSource,
        rootKey,
        secondPublicationSequence,
        supportedFeatureBits,
      });
      return { commitHomeRef, superblock };
    } catch (cause: unknown) {
      throw new PreparedMutationCommitPublicationError({
        cause,
        commitHomeRef,
        commitPayload,
        intendedLogicalState,
      });
    }
  } finally {
    writer.abandon();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
