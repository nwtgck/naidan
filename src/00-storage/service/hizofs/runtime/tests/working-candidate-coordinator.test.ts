import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  parseMutationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import {
  WorkingCandidateCoordinator,
  WorkingCandidateCoordinatorError,
} from "@/00-storage/service/hizofs/runtime/working-candidate-coordinator";

function commitReference({ offset }: { offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function mutationId({ value }: { value: number }) {
  return parseMutationId({ bytes: new Uint8Array(16).fill(value) });
}

function identities() {
  const baseReference = commitReference({ offset: 64n });
  const baseMutationId = mutationId({ value: 1 });
  const baseWorking = createWorkingGenerationIdentity({
    authorityEpoch: createWorkingGenerationAuthorityEpoch(),
    generationNumber: createWorkingGenerationNumber({ value: 0n }),
    mutationId: baseMutationId,
  });
  const successorReference = commitReference({ offset: 160n });
  const successorMutationId = mutationId({ value: 2 });
  return {
    candidateDurable: createDurableGenerationIdentity({
      commitReference: successorReference,
      commitSequence: createCommitSequence({ value: 8n }),
      mutationId: successorMutationId,
    }),
    durable: createDurableGenerationIdentity({
      commitReference: baseReference,
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: baseMutationId,
    }),
    successor: createSuccessorWorkingGenerationIdentity({
      mutationId: successorMutationId,
      previous: baseWorking,
    }),
  };
}

function coordinator() {
  const releases: string[] = [];
  const value = new WorkingCandidateCoordinator({
    acquireWorkingGenerationDependencyRoot: ({ commitReference }) => ({
      commitReference,
      release: () => releases.push("released"),
    }),
    acquireWorkingGenerationPageRoot: ({ pageReference }) => ({
      pageReference,
      release: () => releases.push("page-released"),
    }),
  });
  return { releases, value };
}

describe("working candidate coordinator", () => {
  it("owns one exact candidate across admissions until publication resolves", () => {
    const { releases, value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const candidate = Object.freeze({ id: "candidate-a" });
    const releaseCandidate = vi.fn();
    const admission = value.openAdmission<typeof candidate>({
      durableBaseIdentity: durable,
      operationLabel: "session A mutation",
    });

    admission.install({
      candidate,
      candidateDurableIdentity: candidateDurable,
      releaseCandidate,
      workingIdentity: successor,
    });
    expect(value.publicationState()).toBe("installed");
    expect(admission.matchesWorkingIdentity({ workingIdentity: successor })).toBe(true);
    expect(() => value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "session B mutation",
    })).toThrowError(expect.objectContaining({ code: "candidate_active" }));

    expect(admission.selectCandidateForPublication()).toBe(candidate);
    expect(value.publicationState()).toBe("publishing");
    admission.resolve({ outcome: "published" });
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual(["released"]);
    expect(releaseCandidate).toHaveBeenCalledOnce();

    const next = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "session B mutation",
    });
    next.closeWithoutCandidate();
    expect(value.publicationState()).toBe("empty");
  });


  it("retains and replaces the latest unpublished candidate before runtime publication", () => {
    const { releases, value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const firstCandidate = Object.freeze({ id: "candidate-retained-a" });
    const releaseFirstCandidate = vi.fn();
    const first = value.openAdmission<typeof firstCandidate>({
      durableBaseIdentity: durable,
      operationLabel: "first accepted mutation",
    });
    first.install({
      candidate: firstCandidate,
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: releaseFirstCandidate,
      workingIdentity: successor,
    });
    first.retainInstalled();

    expect(value.publicationState()).toBe("installed");
    expect(releases).toEqual([]);

    const secondReference = commitReference({ offset: 256n });
    const secondMutationId = mutationId({ value: 3 });
    const secondWorking = createSuccessorWorkingGenerationIdentity({
      mutationId: secondMutationId,
      previous: successor,
    });
    const secondCandidate = Object.freeze({ id: "candidate-retained-b" });
    const releaseSecondCandidate = vi.fn();
    const second = value.openAdmission<typeof secondCandidate>({
      durableBaseIdentity: durable,
      operationLabel: "second accepted mutation",
    });
    second.install({
      candidate: secondCandidate,
      candidateDurableIdentity: createDurableGenerationIdentity({
        commitReference: secondReference,
        commitSequence: candidateDurable.commitSequence,
        mutationId: secondMutationId,
      }),
      releaseCandidate: releaseSecondCandidate,
      workingIdentity: secondWorking,
    });
    expect(releases).toEqual([]);
    second.retainInstalled();
    expect(releases).toEqual(["released"]);
    expect(releaseFirstCandidate).toHaveBeenCalledOnce();
    expect(releaseSecondCandidate).not.toHaveBeenCalled();

    const firstPublication = value.openCurrentPublication<typeof secondCandidate>();
    expect(firstPublication.candidate).toBe(secondCandidate);
    expect(firstPublication.workingIdentity).toEqual(secondWorking);
    expect(value.publicationState()).toBe("publishing");
    firstPublication.restoreInstalled();
    expect(value.publicationState()).toBe("installed");

    const retry = value.openCurrentPublication<typeof secondCandidate>();
    retry.completePublished();
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual(["released", "released"]);
    expect(releaseSecondCandidate).toHaveBeenCalledOnce();
  });

  it("poisons the coordinator without rolling back the new candidate when replaced-root release fails", () => {
    const releases: number[] = [];
    let registrationIndex = 0;
    const failure = new Error("replaced candidate root release failed");
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => {
        const index = registrationIndex;
        registrationIndex += 1;
        return {
          commitReference,
          release: () => {
            releases.push(index);
            if (index === 0) throw failure;
          },
        };
      },
      acquireWorkingGenerationPageRoot: ({ pageReference }) => ({
        pageReference,
        release: () => undefined,
      }),
    });
    const { candidateDurable, durable, successor } = identities();
    const first = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "first retained mutation",
    });
    first.install({
      candidate: Object.freeze({ id: "first" }),
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    first.retainInstalled();

    const secondReference = commitReference({ offset: 320n });
    const secondMutationId = mutationId({ value: 4 });
    const secondWorking = createSuccessorWorkingGenerationIdentity({
      mutationId: secondMutationId,
      previous: successor,
    });
    const second = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "second retained mutation",
    });
    second.install({
      candidate: Object.freeze({ id: "second" }),
      candidateDurableIdentity: createDurableGenerationIdentity({
        commitReference: secondReference,
        commitSequence: candidateDurable.commitSequence,
        mutationId: secondMutationId,
      }),
      releaseCandidate: () => undefined,
      workingIdentity: secondWorking,
    });

    expect(() => second.retainInstalled()).toThrowError(expect.objectContaining({
      cause: failure,
      code: "coordinator_poisoned",
    }));
    expect(value.publicationState()).toBe("outcome_unknown");
    expect(releases).toEqual([0]);
    expect(() => value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "later mutation",
    })).toThrowError(expect.objectContaining({ code: "coordinator_poisoned" }));
  });

  it("rejects replacement when its durable base differs from the retained dirty epoch", () => {
    const { value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const first = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "retained mutation",
    });
    first.install({
      candidate: Object.freeze({ id: "candidate-retained" }),
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    first.retainInstalled();

    expect(() => value.openAdmission({
      durableBaseIdentity: createDurableGenerationIdentity({
        commitReference: candidateDurable.commitReference,
        commitSequence: candidateDurable.commitSequence,
        mutationId: candidateDurable.mutationId,
      }),
      operationLabel: "wrong durable base mutation",
    })).toThrowError(expect.objectContaining({ code: "candidate_identity_mismatch" }));
    expect(value.publicationState()).toBe("installed");
  });

  it("retains an outcome-unknown candidate root and poisons later admissions", () => {
    const { releases, value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "uncertain mutation",
    });
    admission.install({
      candidate: Object.freeze({ id: "candidate-b" }),
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    const cause = new Error("publication outcome unknown");
    admission.retainOutcomeUnknown({ cause });

    expect(value.publicationState()).toBe("outcome_unknown");
    expect(releases).toEqual([]);
    expect(() => value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "later mutation",
    })).toThrowError(expect.objectContaining({
      cause,
      code: "coordinator_poisoned",
    }));
    expect(() => admission.selectCandidateForPublication()).toThrowError(
      expect.objectContaining({ code: "admission_closed" }),
    );

    expect(value.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: durable,
    })).toBe("confirmed_not_published");
    expect(value.publicationState()).toBe("empty");
    expect(releases).toHaveLength(1);
    const next = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "recovered mutation",
    });
    next.closeWithoutCandidate();
  });

  it("derives a published outcome from the exact authenticated candidate identity", () => {
    const { releases, value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "published uncertain mutation",
    });
    admission.install({
      candidate: Object.freeze({ id: "candidate-published" }),
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    admission.retainOutcomeUnknown({ cause: new Error("publication outcome unknown") });

    expect(value.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: candidateDurable,
    })).toBe("confirmed_published");
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual(["released"]);
  });

  it("retains an outcome-unknown candidate when durable authority conflicts", () => {
    const { releases, value } = coordinator();
    const { candidateDurable, durable, successor } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "conflicting uncertain mutation",
    });
    admission.install({
      candidate: Object.freeze({ id: "candidate-conflict" }),
      candidateDurableIdentity: candidateDurable,
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    });
    const cause = new Error("publication outcome unknown");
    admission.retainOutcomeUnknown({ cause });
    const unrelated = createDurableGenerationIdentity({
      commitReference: commitReference({ offset: 256n }),
      commitSequence: createCommitSequence({ value: 9n }),
      mutationId: mutationId({ value: 3 }),
    });

    expect(() => value.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: unrelated,
    })).toThrowError(expect.objectContaining({
      cause,
      code: "outcome_resolution_conflict",
    }));
    expect(value.publicationState()).toBe("outcome_unknown");
    expect(releases).toEqual([]);

    expect(value.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: durable,
    })).toBe("confirmed_not_published");
  });

  it("rejects outcome resolution unless the candidate is outcome-unknown", () => {
    const { value } = coordinator();
    const { durable } = identities();
    expect(() => value.resolveOutcomeUnknownAgainstDurableAuthority({
      observedDurableIdentity: durable,
    })).toThrowError(expect.objectContaining({ code: "outcome_resolution_invalid" }));
  });

  it("releases an empty reservation without registering a maintenance root", () => {
    const { releases, value } = coordinator();
    const { durable } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "no-change mutation",
    });

    admission.closeWithoutCandidate();
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual([]);
    expect(() => admission.closeWithoutCandidate()).toThrowError(
      expect.objectContaining({ code: "admission_closed" }),
    );
  });

  it("rejects a candidate Mutation ID that disagrees with its working identity", () => {
    const { releases, value } = coordinator();
    const { durable, successor } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "mismatched candidate mutation",
    });

    expect(() => admission.install({
      candidate: Object.freeze({ id: "candidate-c" }),
      candidateDurableIdentity: createDurableGenerationIdentity({
        commitReference: commitReference({ offset: 256n }),
        commitSequence: createCommitSequence({ value: 8n }),
        mutationId: mutationId({ value: 99 }),
      }),
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    })).toThrowError(expect.objectContaining({ code: "candidate_identity_mismatch" }));
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual([]);
    admission.closeWithoutCandidate();
  });

  it("retains staged working-page roots without inventing a physical Commit identity", () => {
    const releases: string[] = [];
    const commitAcquisitions = vi.fn();
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => {
        commitAcquisitions(commitReference);
        return { commitReference, release: () => releases.push("commit") };
      },
      acquireWorkingGenerationPageRoot: ({ pageReference }) => ({
        pageReference,
        release: () => releases.push("page"),
      }),
    });
    const { durable, successor } = identities();
    const page = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 512n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(8) }),
    } });
    const candidate = Object.freeze({ id: "staged" });
    const releaseCandidate = vi.fn();
    const admission = value.openAdmission<typeof candidate>({
      durableBaseIdentity: durable,
      operationLabel: "staged mutation",
    });

    admission.installStaged({
      candidate,
      releaseCandidate,
      workingIdentity: successor,
      workingPageReferences: [page],
    });
    admission.retainInstalled();

    expect(value.publicationState()).toBe("installed");
    expect(value.retainedInstalledCandidateCommitReference()).toBeUndefined();
    expect(commitAcquisitions).not.toHaveBeenCalled();
    expect(releases).toEqual([]);

    const publication = value.openCurrentPublication<typeof candidate>();
    expect(publication.candidate).toBe(candidate);
    expect(() => publication.requireCandidateDurableIdentity()).toThrowError(
      expect.objectContaining({ code: "candidate_not_materialized" }),
    );
    expect(() => publication.retainOutcomeUnknown({ cause: new Error("too early") })).toThrowError(
      expect.objectContaining({ code: "candidate_not_materialized" }),
    );
    publication.restoreInstalled();
    expect(value.publicationState()).toBe("installed");
    expect(releases).toEqual([]);
    expect(releaseCandidate).not.toHaveBeenCalled();
  });

  it("acquires replacement staged roots before releasing the previous staged authority", () => {
    const events: string[] = [];
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => ({
        commitReference,
        release: () => events.push("release:commit"),
      }),
      acquireWorkingGenerationPageRoot: ({ pageReference }) => {
        const offset = pageReference.byteOffset.toString();
        events.push(`acquire:page:${offset}`);
        return {
          pageReference,
          release: () => events.push(`release:page:${offset}`),
        };
      },
    });
    const { durable, successor } = identities();
    const firstPage = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 640n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(11) }),
    } });
    const secondPage = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 672n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(12) }),
    } });
    const firstRelease = vi.fn(() => events.push("release:candidate:first"));
    const first = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "first staged mutation",
    });
    first.installStaged({
      candidate: Object.freeze({ id: "first-staged" }),
      releaseCandidate: firstRelease,
      workingIdentity: successor,
      workingPageReferences: [firstPage],
    });
    first.retainInstalled();

    const secondMutationId = mutationId({ value: 3 });
    const secondWorking = createSuccessorWorkingGenerationIdentity({
      mutationId: secondMutationId,
      previous: successor,
    });
    const secondRelease = vi.fn(() => events.push("release:candidate:second"));
    const second = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "second staged mutation",
    });
    second.installStaged({
      candidate: Object.freeze({ id: "second-staged" }),
      releaseCandidate: secondRelease,
      workingIdentity: secondWorking,
      workingPageReferences: [secondPage],
    });

    expect(events).toEqual([
      "acquire:page:640",
      "acquire:page:672",
    ]);
    second.retainInstalled();
    expect(events).toEqual([
      "acquire:page:640",
      "acquire:page:672",
      "release:candidate:first",
      "release:page:640",
    ]);
    expect(firstRelease).toHaveBeenCalledWith({ disposition: "discarded" });
    expect(secondRelease).not.toHaveBeenCalled();

    const publication = value.openCurrentPublication();
    publication.bindMaterializedCandidate({
      candidateDurableIdentity: createDurableGenerationIdentity({
        commitReference: commitReference({ offset: 704n }),
        commitSequence: createCommitSequence({ value: 8n }),
        mutationId: secondMutationId,
      }),
    });
    publication.completePublished();
    expect(events).toEqual([
      "acquire:page:640",
      "acquire:page:672",
      "release:candidate:first",
      "release:page:640",
      "release:candidate:second",
      "release:commit",
      "release:page:672",
    ]);
  });

  it("keeps the previous staged candidate installed when replacement root acquisition fails", () => {
    const { durable, successor } = identities();
    const firstPage = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 736n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(13) }),
    } });
    const secondPage = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 768n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(14) }),
    } });
    const rootFailure = new Error("replacement staged root unavailable");
    const releases: string[] = [];
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => ({
        commitReference,
        release: () => releases.push("commit"),
      }),
      acquireWorkingGenerationPageRoot: ({ pageReference }) => {
        if (pageReference.byteOffset === secondPage.byteOffset) throw rootFailure;
        return { pageReference, release: () => releases.push("first-page") };
      },
    });
    const firstRelease = vi.fn();
    const first = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "first staged mutation",
    });
    first.installStaged({
      candidate: Object.freeze({ id: "first-staged" }),
      releaseCandidate: firstRelease,
      workingIdentity: successor,
      workingPageReferences: [firstPage],
    });
    first.retainInstalled();

    const secondWorking = createSuccessorWorkingGenerationIdentity({
      mutationId: mutationId({ value: 3 }),
      previous: successor,
    });
    const second = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "failed staged replacement",
    });
    expect(() => second.installStaged({
      candidate: Object.freeze({ id: "second-staged" }),
      releaseCandidate: vi.fn(),
      workingIdentity: secondWorking,
      workingPageReferences: [secondPage],
    })).toThrow(rootFailure);
    second.closeWithoutCandidate();

    expect(value.publicationState()).toBe("installed");
    expect(firstRelease).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
    const retained = value.openCurrentPublication();
    expect(retained.workingIdentity).toEqual(successor);
    retained.restoreInstalled();
  });

  it("binds a staged candidate to its exact materialized Commit before publication can complete", () => {
    const releases: string[] = [];
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => ({
        commitReference,
        release: () => releases.push("commit"),
      }),
      acquireWorkingGenerationPageRoot: ({ pageReference }) => ({
        pageReference,
        release: () => releases.push("page"),
      }),
    });
    const { candidateDurable, durable, successor } = identities();
    const page = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 544n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(9) }),
    } });
    const releaseCandidate = vi.fn();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "staged materialization",
    });
    admission.installStaged({
      candidate: Object.freeze({ id: "staged-materialized" }),
      releaseCandidate,
      workingIdentity: successor,
      workingPageReferences: [page],
    });
    admission.retainInstalled();

    const publication = value.openCurrentPublication();
    publication.bindMaterializedCandidate({ candidateDurableIdentity: candidateDurable });
    expect(publication.requireCandidateDurableIdentity()).toEqual(candidateDurable);
    publication.completePublished();

    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual(["commit", "page"]);
    expect(releaseCandidate).toHaveBeenCalledWith({ disposition: "confirmed_published" });
  });

  it("keeps a staged candidate retryable when materialized identity validation fails", () => {
    const releases: string[] = [];
    const commitAcquisitions = vi.fn();
    const value = new WorkingCandidateCoordinator({
      acquireWorkingGenerationDependencyRoot: ({ commitReference }) => {
        commitAcquisitions(commitReference);
        return { commitReference, release: () => releases.push("commit") };
      },
      acquireWorkingGenerationPageRoot: ({ pageReference }) => ({
        pageReference,
        release: () => releases.push("page"),
      }),
    });
    const { durable, successor } = identities();
    const page = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 576n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(10) }),
    } });
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "stale materialization",
    });
    admission.installStaged({
      candidate: Object.freeze({ id: "staged-retry" }),
      releaseCandidate: () => undefined,
      workingIdentity: successor,
      workingPageReferences: [page],
    });
    admission.retainInstalled();
    const publication = value.openCurrentPublication();

    expect(() => publication.bindMaterializedCandidate({
      candidateDurableIdentity: createDurableGenerationIdentity({
        commitReference: commitReference({ offset: 608n }),
        commitSequence: createCommitSequence({ value: 9n }),
        mutationId: successor.mutationId,
      }),
    })).toThrowError(expect.objectContaining({ code: "candidate_identity_mismatch" }));
    expect(commitAcquisitions).not.toHaveBeenCalled();
    publication.restoreInstalled();
    expect(value.publicationState()).toBe("installed");
    expect(releases).toEqual([]);
  });

  it("rejects candidate selection before installation", () => {
    const { value } = coordinator();
    const { durable } = identities();
    const admission = value.openAdmission({
      durableBaseIdentity: durable,
      operationLabel: "missing candidate mutation",
    });

    expect(() => admission.selectCandidateForPublication()).toThrowError(
      expect.objectContaining({ code: "candidate_missing" }),
    );
    expect(() => admission.selectCandidateForPublication()).toThrowError(WorkingCandidateCoordinatorError);
    admission.closeWithoutCandidate();
  });
});
