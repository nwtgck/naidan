import { describe, expect, it } from "vitest";
import type { ModelSupportInvestigationRun } from "@/features/transformers-js/model-support-investigation/types";
import {
  createModelSupportInvestigationEvidenceWorkerRequest,
  readModelSupportInvestigationEvidenceWorkerRequest,
} from "@/features/transformers-js/model-support-investigation/evidence-worker/request";

describe("Model Support Investigation Evidence Worker request", () => {
  it("serializes the large run graph into a clone-safe Blob before crossing the Worker boundary", async () => {
    const run = { runId: "run-1", modelId: "model-1" } as ModelSupportInvestigationRun;
    const request = createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery: undefined });

    expect(request).toBeInstanceOf(Blob);
    expect(() => structuredClone(request)).not.toThrow();
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).resolves.toEqual({
      schemaVersion: 1,
      run: { runId: "run-1", modelId: "model-1" },
    });
  });

  it("rejects an accidental non-cloneable value before postMessage can see it", () => {
    const run = {
      runId: "unsafe-run",
      accidentalCallback: () => undefined,
    } as unknown as ModelSupportInvestigationRun;

    expect(() => createModelSupportInvestigationEvidenceWorkerRequest({
      run,
      recovery: undefined,
    })).toThrow();
  });

  it("rejects malformed serialized requests inside the Evidence Worker", async () => {
    const request = new Blob([JSON.stringify({ schemaVersion: 999, run: {} })], { type: "application/json" });
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).rejects.toThrow(
      "Invalid Model Support Investigation Evidence Worker request",
    );
  });
});
