import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";
import { createCacheRevisionAliases } from "./create-cache-revision-aliases";

const repository = {
  normalizedModelId: "org/model",
  requestedRevision: "main",
  resolvedRevision: "a".repeat(40),
} as ModelSupportInvestigationRepository;

function provenance(): ModelSupportInvestigationCacheProvenance {
  return {
    schemaVersion: 1,
    method: "bounded-range-sha256-v1",
    resolvedRevision: repository.resolvedRevision,
    rangeBytes: 32 * 1024,
    maximumFileCount: 3,
    status: "partial",
    confidence: "incomplete",
    reason: "fixture",
    files: [{
      cachePath: "resolve/main/onnx/model_q4.onnx",
      repositoryPath: "onnx/model_q4.onnx",
      cacheRevision: "main",
      localSize: 100,
      repositorySize: 100,
      status: "bounded-samples-matched",
      ranges: [],
      reason: "matched",
    }, {
      cachePath: "resolve/main/onnx/model_q4.onnx_data",
      repositoryPath: "onnx/model_q4.onnx_data",
      cacheRevision: "main",
      localSize: 100,
      repositorySize: 100,
      status: "partial",
      ranges: [],
      reason: "not verified",
    }, {
      cachePath: `resolve/${repository.resolvedRevision}/config.json`,
      repositoryPath: "config.json",
      cacheRevision: repository.resolvedRevision,
      localSize: 100,
      repositorySize: 100,
      status: "bounded-samples-matched",
      ranges: [],
      reason: "already exact",
    }],
  };
}

describe("createCacheRevisionAliases", () => {
  it("aliases only non-exact cache files whose bounded samples matched", () => {
    expect(createCacheRevisionAliases({ repository, provenance: provenance() })).toEqual([{
      modelId: "org/model",
      resolvedRevision: repository.resolvedRevision,
      sourceRevision: "main",
      repositoryPaths: ["onnx/model_q4.onnx"],
    }]);
  });

  it("returns no aliases without bounded provenance", () => {
    expect(createCacheRevisionAliases({ repository, provenance: undefined })).toEqual([]);
  });
});
