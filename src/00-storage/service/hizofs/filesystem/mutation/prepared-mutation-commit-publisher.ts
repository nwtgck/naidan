import {
  encodeFileSystemCommitPayload,
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type {
  MutationSuperblockPublicationResolution,
  OpenedSuperblockCopies,
  SuperblockLogicalState,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  prepareMutationCandidateSequencePlan,
  prepareMutationSuperblockPublicationPlan,
} from "./mutation-publication-plan";

export type PublishedPreparedMutationCommit = Readonly<{
  commitHomeRef: HomeRecordReference;
  superblock: OpenedSuperblockCopies;
}>;

export type PreparedMutationCommitCandidate = Readonly<{
  commitHomeRef: HomeRecordReference;
  commitPayload: FileSystemCommitPayload;
}>;

export type PreparedMutationCommitCandidateAppendRequest = Readonly<{
  commitPayload: FileSystemCommitPayload;
}>;

export type PreparedMutationCommitDurablePublicationRequest = Readonly<{
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite: () => void;
  candidate: PreparedMutationCommitCandidate;
  firstPublicationSequence: PublicationSequence;
  secondPublicationSequence: PublicationSequence;
}>;

export type AppendPreparedMutationCommitCandidate = ({
  commitPayload,
}: PreparedMutationCommitCandidateAppendRequest) => Promise<PreparedMutationCommitCandidate>;

export type PublishPreparedMutationCommitCandidate = ({
  base,
  beforeFirstAuthorityWrite,
  candidate,
  firstPublicationSequence,
  secondPublicationSequence,
}: PreparedMutationCommitDurablePublicationRequest) => Promise<PublishedPreparedMutationCommit>;

export type PreparedMutationCommitDurablePublicationPort = Readonly<{
  abandon: () => void;
  publishCandidate: PublishPreparedMutationCommitCandidate;
}>;

export type ResolvablePreparedMutationCommitDurablePublicationPort =
  PreparedMutationCommitDurablePublicationPort & Readonly<{
    completeExternallyResolvedPublication: ({ outcome }: {
      outcome: "not_published" | "published";
    }) => void;
    resolvePublication: ({ base, intendedLogicalState }: {
      base: OpenedSuperblockCopies;
      intendedLogicalState: SuperblockLogicalState;
    }) => Promise<MutationSuperblockPublicationResolution>;
  }>;

export type PreparedMutationCommitPublicationPort = Readonly<{
  appendCandidate: AppendPreparedMutationCommitCandidate;
  detachPreparedCandidatePublication?: ({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }) => PreparedMutationCommitDurablePublicationPort;
  publishCandidate: PublishPreparedMutationCommitCandidate;
}>;

export type DeferredPreparedMutationCommitPublication = Readonly<{
  candidate: PreparedMutationCommitCandidate;
  publicationPort: ResolvablePreparedMutationCommitDurablePublicationPort;
}>;

export type DetachablePreparedMutationCommitPublicationPort =
  Omit<PreparedMutationCommitPublicationPort, "detachPreparedCandidatePublication"> & Readonly<{
    detachPreparedCandidatePublication: ({ candidate }: {
      candidate: PreparedMutationCommitCandidate;
    }) => ResolvablePreparedMutationCommitDurablePublicationPort;
  }>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameCommitPayload({ left, right }: {
  left: FileSystemCommitPayload;
  right: FileSystemCommitPayload;
}): boolean {
  return bytesEqual({
    left: encodeFileSystemCommitPayload({ payload: left }),
    right: encodeFileSystemCommitPayload({ payload: right }),
  });
}

function assertCandidatePlan({ base, commitPayload }: {
  base: OpenedSuperblockCopies;
  commitPayload: FileSystemCommitPayload;
}): void {
  const candidatePlan = prepareMutationCandidateSequencePlan({
    durableCommitSequence: base.logicalState.activeCommitSequence,
  });
  if (commitPayload.commitSequence !== candidatePlan.newCommitSequence) {
    throw new RangeError("prepared Commit Sequence does not match the mutation candidate plan");
  }
  if (commitPayload.mutationId.every((byte, index) => byte === base.logicalState.activeMutationId[index])) {
    throw new TypeError("prepared Commit requires a fresh Mutation ID");
  }
}

export async function appendPreparedMutationCommitCandidateThroughPort({
  assertPublicationAllowed,
  base,
  commitPayload,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  base: OpenedSuperblockCopies;
  commitPayload: FileSystemCommitPayload;
  publicationPort: PreparedMutationCommitPublicationPort;
}): Promise<PreparedMutationCommitCandidate> {
  assertCandidatePlan({ base, commitPayload });
  assertPublicationAllowed();
  const candidate = await publicationPort.appendCandidate({ commitPayload });
  if (!sameCommitPayload({ left: candidate.commitPayload, right: commitPayload })) {
    throw new TypeError("authenticated mutation candidate does not match the prepared Commit payload");
  }
  return candidate;
}

export async function publishPreparedMutationCommitCandidateThroughPort({
  assertPublicationAllowed,
  base,
  candidate,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  base: OpenedSuperblockCopies;
  candidate: PreparedMutationCommitCandidate;
  publicationPort: Pick<PreparedMutationCommitPublicationPort, "publishCandidate">;
}): Promise<PublishedPreparedMutationCommit> {
  assertCandidatePlan({ base, commitPayload: candidate.commitPayload });
  const publicationPlan = prepareMutationSuperblockPublicationPlan({
    maximumStructurallyObservedPublicationSequence: base.maximumStructurallyObservedPublicationSequence,
  });
  assertPublicationAllowed();
  let finalGateFailed = false;
  let finalGateFailure: unknown;
  try {
    return await publicationPort.publishCandidate({
      base,
      beforeFirstAuthorityWrite: () => {
        try {
          assertPublicationAllowed();
        } catch (cause: unknown) {
          finalGateFailed = true;
          finalGateFailure = cause;
          throw cause;
        }
      },
      candidate,
      firstPublicationSequence: publicationPlan.firstPublicationSequence,
      secondPublicationSequence: publicationPlan.secondPublicationSequence,
    });
  } catch (cause: unknown) {
    if (finalGateFailed) throw finalGateFailure;
    throw cause;
  }
}

export async function prepareDeferredMutationCommitPublication({
  assertPublicationAllowed,
  base,
  commitPayload,
  onCandidatePrepared,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  base: OpenedSuperblockCopies;
  commitPayload: FileSystemCommitPayload;
  onCandidatePrepared: (({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }) => PreparedMutationCommitCandidate) | undefined;
  publicationPort: DetachablePreparedMutationCommitPublicationPort;
}): Promise<DeferredPreparedMutationCommitPublication> {
  const candidate = await appendPreparedMutationCommitCandidateThroughPort({
    assertPublicationAllowed,
    base,
    commitPayload,
    publicationPort,
  });
  const selectedCandidate = onCandidatePrepared?.({ candidate }) ?? candidate;
  if (selectedCandidate !== candidate) {
    throw new TypeError("working candidate selection did not return the authenticated candidate");
  }
  assertPublicationAllowed();
  const detachedPublicationPort = publicationPort.detachPreparedCandidatePublication({ candidate });
  return Object.freeze({ candidate, publicationPort: detachedPublicationPort });
}

export async function publishPreparedMutationCommit({
  assertPublicationAllowed,
  base,
  commitPayload,
  onCandidatePrepared,
  onPublicationAuthorityDetached,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  base: OpenedSuperblockCopies;
  commitPayload: FileSystemCommitPayload;
  onCandidatePrepared: (({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }) => PreparedMutationCommitCandidate) | undefined;
  onPublicationAuthorityDetached?: (({ candidate, publicationPort }: {
    candidate: PreparedMutationCommitCandidate;
    publicationPort: PreparedMutationCommitDurablePublicationPort;
  }) => void);
  publicationPort: PreparedMutationCommitPublicationPort;
}): Promise<PublishedPreparedMutationCommit> {
  const candidate = await appendPreparedMutationCommitCandidateThroughPort({
    assertPublicationAllowed,
    base,
    commitPayload,
    publicationPort,
  });
  const selectedCandidate = onCandidatePrepared?.({ candidate }) ?? candidate;
  if (selectedCandidate !== candidate) {
    throw new TypeError("working candidate selection did not return the authenticated candidate");
  }
  const detachedPublicationPort = publicationPort.detachPreparedCandidatePublication?.({ candidate });
  if (detachedPublicationPort !== undefined) {
    onPublicationAuthorityDetached?.({ candidate, publicationPort: detachedPublicationPort });
  }
  let publicationPortInvoked = false;
  try {
    return await publishPreparedMutationCommitCandidateThroughPort({
      assertPublicationAllowed,
      base,
      candidate: selectedCandidate,
      publicationPort: detachedPublicationPort === undefined
        ? publicationPort
        : {
          publishCandidate: async ({
            base,
            beforeFirstAuthorityWrite,
            candidate,
            firstPublicationSequence,
            secondPublicationSequence,
          }) => {
            publicationPortInvoked = true;
            return await detachedPublicationPort.publishCandidate({
              base,
              beforeFirstAuthorityWrite,
              candidate,
              firstPublicationSequence,
              secondPublicationSequence,
            });
          },
        },
    });
  } catch (cause: unknown) {
    if (detachedPublicationPort === undefined || publicationPortInvoked) throw cause;
    try {
      detachedPublicationPort.abandon();
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "publication gate failure and detached authority cleanup both failed",
      );
    }
    throw cause;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
