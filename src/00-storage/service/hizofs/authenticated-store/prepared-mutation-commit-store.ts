import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  copyFileSystemCommitPayload,
  createHomeRecordReference,
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
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  createAuthenticatedSegmentWriter,
  type AuthenticatedSegmentWriter,
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

export type PreparedMutationCommitCandidate = Readonly<{
  commitHomeRef: HomeRecordReference;
  commitPayload: FileSystemCommitPayload;
}>;

type PreparedMutationCommitCandidateAuthority = Readonly<{
  commitHomeRef: HomeRecordReference;
  commitPayload: FileSystemCommitPayload;
}>;

const PREPARED_MUTATION_COMMIT_CANDIDATE_AUTHORITY = new WeakMap<
  PreparedMutationCommitCandidate,
  PreparedMutationCommitCandidateAuthority
>();

function cloneCommitPayload({ payload }: { payload: FileSystemCommitPayload }): FileSystemCommitPayload {
  return copyFileSystemCommitPayload({ payload });
}

function cloneCommitHomeRef({ reference }: { reference: HomeRecordReference }): HomeRecordReference {
  return createHomeRecordReference({ fields: reference });
}

function exposePreparedMutationCommitCandidate({ authority }: {
  authority: PreparedMutationCommitCandidateAuthority;
}): PreparedMutationCommitCandidate {
  const candidate = Object.freeze({
    get commitHomeRef(): HomeRecordReference {
      return cloneCommitHomeRef({ reference: authority.commitHomeRef });
    },
    get commitPayload(): FileSystemCommitPayload {
      return cloneCommitPayload({ payload: authority.commitPayload });
    },
  });
  PREPARED_MUTATION_COMMIT_CANDIDATE_AUTHORITY.set(candidate, authority);
  return candidate;
}

function requirePreparedMutationCommitCandidateAuthority({ candidate }: {
  candidate: PreparedMutationCommitCandidate;
}): PreparedMutationCommitCandidateAuthority {
  const authority = PREPARED_MUTATION_COMMIT_CANDIDATE_AUTHORITY.get(candidate);
  if (authority === undefined) {
    throw new TypeError("prepared mutation Commit candidate is not authenticated by this runtime");
  }
  return authority;
}

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

export async function appendPreparedMutationCommit({
  commitPayload,
  writer,
}: {
  commitPayload: FileSystemCommitPayload;
  writer: AuthenticatedSegmentWriter;
}): Promise<HomeRecordReference> {
  const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit;
  const plaintext = writer.encodeRecordPayload({ encode: () => encodeFileSystemCommitPayload({ payload: commitPayload }) });
  try {
    const appended = await writer.appendCallerOwnedRecord({ plaintext, recordKind });
    switch (appended.type) {
    case "home": return appended.homeReference;
    case "physical_only": throw new Error("File System Commit cannot be a physical-only record");
    default: return appended satisfies never;
    }
  } finally {
    plaintext.fill(0);
  }
}

export async function appendPreparedMutationCommitCandidate({ commitPayload, writer }: {
  commitPayload: FileSystemCommitPayload;
  writer: AuthenticatedSegmentWriter;
}): Promise<PreparedMutationCommitCandidate> {
  const canonicalCommitPayload = cloneCommitPayload({ payload: commitPayload });
  const authority: PreparedMutationCommitCandidateAuthority = Object.freeze({
    commitHomeRef: cloneCommitHomeRef({
      reference: await appendPreparedMutationCommit({
        commitPayload: canonicalCommitPayload,
        writer,
      }),
    }),
    commitPayload: canonicalCommitPayload,
  });
  return exposePreparedMutationCommitCandidate({ authority });
}

export async function publishPreparedMutationCommitCandidate({
  backend,
  base,
  beforeFirstAuthorityWrite,
  candidate,
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
  candidate: PreparedMutationCommitCandidate;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<PublishedPreparedMutationCommit> {
  const authority = requirePreparedMutationCommitCandidateAuthority({ candidate });
  return await publishPreparedMutationCommit({
    backend,
    base,
    beforeFirstAuthorityWrite,
    commitHomeRef: authority.commitHomeRef,
    commitPayload: authority.commitPayload,
    diagnostics,
    fileSystemId,
    firstPublicationSequence,
    randomSource,
    rootKey,
    secondPublicationSequence,
    supportedFeatureBits,
  });
}

export async function publishPreparedMutationCommit({
  backend,
  base,
  beforeFirstAuthorityWrite,
  commitHomeRef,
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
  commitHomeRef: HomeRecordReference;
  commitPayload: FileSystemCommitPayload;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  firstPublicationSequence: PublicationSequence;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  secondPublicationSequence: PublicationSequence;
  supportedFeatureBits: FeatureBits;
}): Promise<PublishedPreparedMutationCommit> {
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
    const candidate = await appendPreparedMutationCommitCandidate({ commitPayload, writer });
    writer.abandon();
    return await publishPreparedMutationCommitCandidate({
      backend,
      base,
      beforeFirstAuthorityWrite,
      candidate,
      diagnostics,
      fileSystemId,
      firstPublicationSequence,
      randomSource,
      rootKey,
      secondPublicationSequence,
      supportedFeatureBits,
    });
  } finally {
    writer.abandon();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
