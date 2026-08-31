import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPartialEvidence: vi.fn(),
}));

vi.mock("@/features/transformers-js/model-support-investigation/logic/create-partial-evidence", () => ({
  createPartialModelSupportEvidence: mocks.createPartialEvidence,
}));

describe("createModelSupportInvestigationEvidenceWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs the complete archive build away from the UI thread", async () => {
    const archive = { blob: new Blob(["zip"]), fileName: "evidence.zip" };
    mocks.createPartialEvidence.mockResolvedValue(archive);
    const { createModelSupportInvestigationEvidenceWorker } = await import("./impl");
    const worker = createModelSupportInvestigationEvidenceWorker();
    const request = new Blob([JSON.stringify({
      schemaVersion: 1,
      run: { runId: "run-1" },
    })], { type: "application/json" });

    await expect(worker.createPartialEvidence({ request })).resolves.toBe(archive);
    expect(mocks.createPartialEvidence).toHaveBeenCalledWith({
      run: { runId: "run-1" },
      recovery: undefined,
    });
  });
});
