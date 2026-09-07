import { describe, expect, it } from "vitest";
import {
  createModelSupportInvestigationBatchEvidenceWorkerRequest,
  readModelSupportInvestigationBatchEvidenceWorkerRequest,
} from "@/features/transformers-js/model-support-investigation/evidence-worker/batch-request";

const items = [{
  target: "org/model-a",
  status: "passed" as const,
  run: { runId: "run-a", modelId: "org/model-a" } as never,
  recovery: undefined,
  error: undefined,
}];

describe("Model Support Investigation batch Evidence Worker request", () => {
  it("round-trips every requested target as clone-safe JSON", async () => {
    const request = createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: "batch-1", items });
    await expect(readModelSupportInvestigationBatchEvidenceWorkerRequest({ request })).resolves.toEqual({
      schemaVersion: 1,
      batchId: "batch-1",
      items,
    });
  });

  it("rejects an empty target list", async () => {
    const request = new Blob([JSON.stringify({ schemaVersion: 1, batchId: "batch-1", items: [] })]);
    await expect(readModelSupportInvestigationBatchEvidenceWorkerRequest({ request })).rejects.toThrow(
      "Invalid Model Support Investigation batch Evidence Worker request",
    );
  });
});
