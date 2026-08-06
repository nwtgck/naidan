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
    commitReference: baseReference,
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
      commitReference: successorReference,
      mutationId: successorMutationId,
      previous: baseWorking,
    }),
  };
}

function coordinator() {
  const releases: string[] = [];
  const value = new WorkingCandidateCoordinator({
    acquireWriterDependencyRoot: ({ commitReference }) => ({
      commitReference,
      release: () => releases.push("released"),
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
      commitReference: secondReference,
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
      acquireWriterDependencyRoot: ({ commitReference }) => {
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
      commitReference: secondReference,
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

  it("rejects a candidate root that disagrees with its working identity", () => {
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
        mutationId: successor.mutationId,
      }),
      releaseCandidate: () => undefined,
      workingIdentity: successor,
    })).toThrowError(expect.objectContaining({ code: "candidate_identity_mismatch" }));
    expect(value.publicationState()).toBe("empty");
    expect(releases).toEqual([]);
    admission.closeWithoutCandidate();
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
