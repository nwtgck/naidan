import { describe, expect, it } from "vitest";
import { MutationPublicationOutcomeTracker } from "@/00-storage/service/hizofs/filesystem/mutation/mutation-publication-outcome";

describe("mutation publication outcome tracker", () => {
  it("allows definitive abort only before the first authority write starts", () => {
    const tracker = new MutationPublicationOutcomeTracker();
    expect(tracker.canAbort()).toBe(true);
    expect(tracker.classifyFailure()).toEqual({ type: "not_published" });
    tracker.startFirstAuthorityWrite();
    expect(tracker.canAbort()).toBe(false);
    expect(tracker.classifyFailure()).toEqual({ type: "outcome_resolution_required" });
  });

  it("classifies failure after the first proof-valid copy as committed but degraded", () => {
    const tracker = new MutationPublicationOutcomeTracker();
    tracker.startFirstAuthorityWrite();
    tracker.markFirstAuthorityVerified();
    expect(tracker.classifyFailure()).toEqual({ type: "committed_redundancy_degraded" });
    expect(tracker.canAbort()).toBe(false);
  });

  it("reports success only after second-copy convergence", () => {
    const tracker = new MutationPublicationOutcomeTracker();
    tracker.startFirstAuthorityWrite();
    tracker.markFirstAuthorityVerified();
    tracker.markSecondCopyConverged();
    expect(tracker.outcome()).toEqual({ type: "succeeded" });
    expect(() => tracker.classifyFailure()).toThrow("successful publication");
  });

  it("rejects skipped and duplicate publication transitions", () => {
    const tracker = new MutationPublicationOutcomeTracker();
    expect(() => tracker.markFirstAuthorityVerified()).toThrow("first authority write");
    tracker.startFirstAuthorityWrite();
    expect(() => tracker.startFirstAuthorityWrite()).toThrow("already started");
    expect(() => tracker.markSecondCopyConverged()).toThrow("first authority copy");
  });
});
