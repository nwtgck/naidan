import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPartialEvidence: vi.fn(),
  createDownloadVerificationEvidence: vi.fn(),
}));

vi.mock("@/features/transformers-js/model-support-investigation/logic/create-partial-evidence", () => ({
  createPartialModelSupportEvidence: mocks.createPartialEvidence,
}));

vi.mock("@/features/transformers-js/download-verification/evidence/create-download-verification-evidence", () => ({
  createDownloadVerificationEvidence: mocks.createDownloadVerificationEvidence,
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
  it("builds Download Verification Evidence from the clone-safe request", async () => {
    const archive = { blob: new Blob(["zip"]), fileName: "download-evidence.zip" };
    mocks.createDownloadVerificationEvidence.mockResolvedValue(archive);
    const { createModelSupportInvestigationEvidenceWorker } = await import("./impl");
    const worker = createModelSupportInvestigationEvidenceWorker();
    const evidence = { schemaVersion: 1, runId: "download-run-1", mode: "probe-only" };
    const request = new Blob([JSON.stringify({ schemaVersion: 1, evidence })], { type: "application/json" });

    await expect(worker.createDownloadVerificationEvidence({ request })).resolves.toBe(archive);
    expect(mocks.createDownloadVerificationEvidence).toHaveBeenCalledWith({ evidence });
  });

});
