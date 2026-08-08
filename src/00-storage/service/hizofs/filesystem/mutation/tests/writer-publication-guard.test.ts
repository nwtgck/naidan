import { describe, expect, it } from "vitest";
import {
  createCommitSequence,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import { createTestingHomeRecordReference } from "@/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
  sameDurableGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import {
  evaluateWriterPublicationEligibility,
  type CapturedWriterIdentity,
} from "@/00-storage/service/hizofs/filesystem/mutation/writer-publication-guard";

const authorityEpoch = createWorkingGenerationAuthorityEpoch();
const baseWorkingGeneration = createWorkingGenerationIdentity({
  authorityEpoch,
  generationNumber: createWorkingGenerationNumber({ value: 7n }),
  mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(1) }),
});

const captured: CapturedWriterIdentity = {
  baseWorkingGeneration,
  inodeNumber: createInodeNumber({ value: 42n }),
  inodeRevision: createInodeRevision({ value: 3n }),
  subvolumeId: createSubvolumeId({ value: 2n }),
};

type CurrentWriterState = Parameters<typeof evaluateWriterPublicationEligibility>[0]["current"];
type CurrentWriterInode = NonNullable<CurrentWriterState["inode"]>;

function currentInode(): CurrentWriterInode {
  return {
    inodeNumber: createInodeNumber({ value: 42n }),
    inodeRevision: createInodeRevision({ value: 3n }),
    subvolumeId: createSubvolumeId({ value: 2n }),
  };
}

function current(overrides: Partial<CurrentWriterState> = {}): CurrentWriterState {
  return {
    workingGeneration: baseWorkingGeneration,
    inode: currentInode(),
    ordinaryDirectoryEntryReachability: 1,
    ...overrides,
  };
}

describe("writer publication guard", () => {
  it("allows rename because path is not writer identity", () => {
    expect(evaluateWriterPublicationEligibility({ captured, current: current() })).toEqual({ type: "eligible" });
  });

  it("rejects a successor working candidate while durable Commit Sequence remains unchanged", () => {
    const durableBefore = createDurableGenerationIdentity({
      commitReference: createTestingHomeRecordReference({ offset: 64n }),
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    });
    const durableAfter = createDurableGenerationIdentity({
      commitReference: createTestingHomeRecordReference({ offset: 64n }),
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    });
    const successor = createSuccessorWorkingGenerationIdentity({
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(2) }),
      previous: baseWorkingGeneration,
    });

    expect(sameDurableGenerationIdentity({ left: durableBefore, right: durableAfter })).toBe(true);
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ workingGeneration: successor }),
    })).toEqual({ reason: "working_generation_changed", type: "conflict" });
  });

  it("rejects stale working generation and stale inode revision", () => {
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({
        workingGeneration: createSuccessorWorkingGenerationIdentity({
          mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(2) }),
          previous: baseWorkingGeneration,
        }),
      }),
    })).toEqual({ reason: "working_generation_changed", type: "conflict" });
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ inode: { ...currentInode(), inodeRevision: createInodeRevision({ value: 4n }) } }),
    })).toEqual({ reason: "inode_revision_changed", type: "conflict" });
  });

  it("rejects unlink, replacement, and invalid multiple reachability", () => {
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ inode: null, ordinaryDirectoryEntryReachability: 0 }),
    })).toEqual({ reason: "inode_unlinked_or_replaced", type: "conflict" });
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ inode: { ...currentInode(), inodeNumber: createInodeNumber({ value: 43n }) } }),
    })).toEqual({ reason: "inode_unlinked_or_replaced", type: "conflict" });
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ ordinaryDirectoryEntryReachability: 2 }),
    })).toEqual({ reason: "ordinary_reachability_invalid", type: "conflict" });
  });

  it("rejects cross-Subvolume identity changes", () => {
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ inode: { ...currentInode(), subvolumeId: createSubvolumeId({ value: 3n }) } }),
    })).toEqual({ reason: "inode_unlinked_or_replaced", type: "conflict" });
  });
});
