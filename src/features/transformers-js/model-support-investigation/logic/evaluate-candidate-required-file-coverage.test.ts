import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCandidateFilePlan,
} from "@/features/transformers-js/model-support-investigation/types";
import { evaluateCandidateRequiredFileCoverage } from "./evaluate-candidate-required-file-coverage";

function plannedFile(path: string, requirement: "required" | "optional") {
  return {
    path,
    kind: path.endsWith(".onnx") ? "core-onnx" as const : "external-data" as const,
    requirement,
    repositoryObservation: "present" as const,
    repositorySize: 10,
    repositoryBlobId: undefined,
    repositoryLfsOid: undefined,
    cacheMatches: [],
  };
}

describe("evaluateCandidateRequiredFileCoverage", () => {
  it("classifies exact required repository paths without inferring revision identity", () => {
    const candidate = {
      candidateId: "webgpu-q4",
      device: "webgpu",
      dtype: "q4",
      registryStatus: "planned",
      registryError: undefined,
      registryReturnedFileCount: 4,
      duplicatePaths: [],
      files: [
        plannedFile("onnx/model_q4.onnx", "required"),
        plannedFile("onnx/model_q4.onnx_data", "required"),
        plannedFile("onnx/model_q4.onnx_data_1", "required"),
        plannedFile("generation_config.json", "optional"),
      ],
      requiredFileCount: 3,
      optionalFileCount: 1,
      missingRequiredFileCount: 0,
      zeroByteRequiredFileCount: 0,
      missingOptionalFileCount: 0,
      cacheObservedRequiredFileCount: 0,
      cacheCompleteMarkerRequiredFileCount: 0,
      eligibility: "eligible",
      ineligibleReasons: [],
    } satisfies ModelSupportInvestigationCandidateFilePlan;
    const inventory = {
      normalizedModelId: "org/model",
      rootPath: "models/huggingface.co/org/model",
      exists: true,
      revisionProvenance: "unknown",
      revisionProvenanceReason: "revision is not persisted",
      totalBytes: 20,
      fileCount: 2,
      completionMarkerCount: 1,
      incompleteFileCount: 1,
      orphanCompletionMarkerCount: 0,
      orphanCompletionMarkerPaths: [],
      zeroByteFileCount: 1,
      weightFileCount: 2,
      allFilesHaveCompletionMarkers: false,
      files: [
        { path: "a", repositoryPath: "onnx/model_q4.onnx", size: 20, lastModified: 1, hasCompletionMarker: true, isWeightFile: true },
        { path: "b", repositoryPath: "onnx/model_q4.onnx_data", size: 0, lastModified: 1, hasCompletionMarker: false, isWeightFile: true },
      ],
    } satisfies ModelSupportInvestigationCacheInventory;

    expect(evaluateCandidateRequiredFileCoverage({ candidate, inventory })).toEqual({
      expectedPaths: ["onnx/model_q4.onnx", "onnx/model_q4.onnx_data", "onnx/model_q4.onnx_data_1"],
      completePaths: ["onnx/model_q4.onnx"],
      incompletePaths: ["onnx/model_q4.onnx_data"],
      missingPaths: ["onnx/model_q4.onnx_data_1"],
      revisionProvenance: "unknown",
    });
  });
});
