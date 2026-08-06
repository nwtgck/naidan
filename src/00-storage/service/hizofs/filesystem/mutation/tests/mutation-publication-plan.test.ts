import { describe, expect, it } from "vitest";
import {
  createCommitSequence,
  createPublicationSequence,
  UINT64_MAXIMUM,
} from "@/00-storage/service/hizofs/00-format";
import {
  prepareMutationCandidateSequencePlan,
  prepareMutationPublicationPlan,
  prepareMutationSuperblockPublicationPlan,
} from "@/00-storage/service/hizofs/filesystem/mutation/mutation-publication-plan";

describe("mutation publication sequence preflight", () => {
  it("reserves candidate and durable publication sequence spaces independently", () => {
    expect(prepareMutationCandidateSequencePlan({
      durableCommitSequence: createCommitSequence({ value: 7n }),
    })).toEqual({ newCommitSequence: 8n });
    expect(prepareMutationSuperblockPublicationPlan({
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 10n }),
    })).toEqual({
      firstPublicationSequence: 11n,
      secondPublicationSequence: 12n,
    });
  });

  it("reserves exactly two fresh physical sequences and base plus one Commit", () => {
    expect(prepareMutationPublicationPlan({
      baseCommitSequence: createCommitSequence({ value: 7n }),
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 10n }),
    })).toEqual({
      firstPublicationSequence: 11n,
      newCommitSequence: 8n,
      secondPublicationSequence: 12n,
    });
  });

  it("allows the final representable pair without wrapping", () => {
    expect(prepareMutationPublicationPlan({
      baseCommitSequence: createCommitSequence({ value: UINT64_MAXIMUM - 1n }),
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: UINT64_MAXIMUM - 2n }),
    })).toEqual({
      firstPublicationSequence: UINT64_MAXIMUM - 1n,
      newCommitSequence: UINT64_MAXIMUM,
      secondPublicationSequence: UINT64_MAXIMUM,
    });
  });

  it("rejects exhausted Commit space before candidate creation and Publication space before flush", () => {
    expect(() => prepareMutationPublicationPlan({
      baseCommitSequence: createCommitSequence({ value: UINT64_MAXIMUM }),
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 1n }),
    })).toThrow("Commit Sequence space");
    expect(() => prepareMutationPublicationPlan({
      baseCommitSequence: createCommitSequence({ value: 1n }),
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: UINT64_MAXIMUM - 1n }),
    })).toThrow("Publication Sequence space");
  });
});
