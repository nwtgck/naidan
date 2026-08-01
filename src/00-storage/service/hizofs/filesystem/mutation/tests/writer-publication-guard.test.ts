import { describe, expect, it } from "vitest";
import {
  createCommitSequence,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import {
  evaluateWriterPublicationEligibility,
  type CapturedWriterIdentity,
} from "@/00-storage/service/hizofs/filesystem/mutation/writer-publication-guard";

const captured: CapturedWriterIdentity = {
  baseCommitSequence: createCommitSequence({ value: 7n }),
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
    commitSequence: createCommitSequence({ value: 7n }),
    inode: currentInode(),
    ordinaryDirectoryEntryReachability: 1,
    ...overrides,
  };
}

describe("writer publication guard", () => {
  it("allows rename because path is not writer identity", () => {
    expect(evaluateWriterPublicationEligibility({ captured, current: current() })).toEqual({ type: "eligible" });
  });

  it("rejects stale base Commit and stale inode revision", () => {
    expect(evaluateWriterPublicationEligibility({
      captured,
      current: current({ commitSequence: createCommitSequence({ value: 8n }) }),
    })).toEqual({ reason: "base_commit_changed", type: "conflict" });
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
