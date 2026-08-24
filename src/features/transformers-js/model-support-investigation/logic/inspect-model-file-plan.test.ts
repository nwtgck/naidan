import { describe, expect, it, vi } from "vitest";
import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";
import { inspectModelFilePlan, TEST_ONLY } from "./inspect-model-file-plan";

function repository(): ModelSupportInvestigationRepository {
  return {
    requestedModelId: "hf.co/org/model",
    normalizedModelId: "org/model",
    requestedRevision: "main",
    resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
    responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
    fileCount: 6,
    files: [
      { path: "config.json", size: 120, blobId: "config-blob", lfsOid: undefined },
      { path: "generation_config.json", size: 60, blobId: "generation-blob", lfsOid: undefined },
      { path: "onnx/model_q4.onnx", size: 400, blobId: undefined, lfsOid: "q4-oid" },
      { path: "onnx/model_q4.onnx_data", size: 800, blobId: undefined, lfsOid: "q4-data-oid" },
      { path: "onnx/model_q4f16.onnx", size: 500, blobId: undefined, lfsOid: "q4f16-oid" },
      { path: "onnx/model_q4f16.onnx_data", size: 900, blobId: undefined, lfsOid: "q4f16-data-oid" },
    ],
    pipelineTag: "text-generation",
    libraryName: "transformers",
    metadata: {},
  };
}

function declarations(): ModelSupportInvestigationModelDeclarations {
  return {
    normalizedModelId: "org/model",
    resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    files: [],
    config: { model_type: "probe" },
    modelType: "probe",
    architectures: ["ProbeForCausalLM"],
    autoMap: undefined,
    transformersJsConfig: undefined,
    classCapabilities: [],
  };
}

function cache(): ModelSupportInvestigationCacheInventory {
  return {
    normalizedModelId: "org/model",
    rootPath: "models/huggingface.co/org/model",
    exists: true,
    revisionProvenance: "unknown",
    revisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
    totalBytes: 1300,
    fileCount: 2,
    completionMarkerCount: 2,
    incompleteFileCount: 0,
    orphanCompletionMarkerCount: 0,
    orphanCompletionMarkerPaths: [],
    zeroByteFileCount: 0,
    weightFileCount: 2,
    allFilesHaveCompletionMarkers: true,
    files: [
      {
        path: "resolve/main/onnx/model_q4.onnx",
        repositoryPath: "onnx/model_q4.onnx",
        size: 400,
        lastModified: 1,
        hasCompletionMarker: true,
        isWeightFile: true,
      },
      {
        path: "resolve/main/onnx/model_q4.onnx_data",
        repositoryPath: "onnx/model_q4.onnx_data",
        size: 800,
        lastModified: 2,
        hasCompletionMarker: true,
        isWeightFile: true,
      },
    ],
  };
}

function registryFiles({ dtype }: { dtype: "q4f16" | "q4" }): string[] {
  const suffix = dtype === "q4f16" ? "q4f16" : "q4";
  return [
    "config.json",
    `onnx/model_${suffix}.onnx`,
    `onnx/model_${suffix}.onnx_data`,
    "generation_config.json",
  ];
}

describe("inspectModelFilePlan", () => {
  it("plans the fixed quantized candidates and compares repository and revision-unknown cache evidence", async () => {
    const getModelFiles = vi.fn(async ({ dtype }: { dtype: "q4f16" | "q4" }) => registryFiles({ dtype }));

    const result = await inspectModelFilePlan({
      repository: repository(),
      declarations: declarations(),
      cache: cache(),
      getModelFiles,
    });

    expect(getModelFiles.mock.calls.map(([args]) => args)).toEqual([
      { modelId: "org/model", device: "webgpu", dtype: "q4f16" },
      { modelId: "org/model", device: "webgpu", dtype: "q4" },
      { modelId: "org/model", device: "wasm", dtype: "q4" },
    ]);
    expect(result.registrySource).toBe("ModelRegistry.get_model_files");
    expect(result.cacheRevisionProvenance).toBe("unknown");
    expect(result.candidates).toHaveLength(3);

    const webGpuQ4 = result.candidates[1];
    expect(webGpuQ4).toMatchObject({
      candidateId: "webgpu-q4",
      eligibility: "eligible",
      requiredFileCount: 3,
      optionalFileCount: 1,
      missingRequiredFileCount: 0,
      cacheObservedRequiredFileCount: 2,
      cacheCompleteMarkerRequiredFileCount: 2,
    });
    expect(webGpuQ4?.files.find(file => file.path === "onnx/model_q4.onnx")).toMatchObject({
      kind: "core-onnx",
      requirement: "required",
      repositoryObservation: "present",
      repositoryLfsOid: "q4-oid",
      cacheMatches: [{
        path: "resolve/main/onnx/model_q4.onnx",
        observation: "complete-marker-observed-revision-unknown",
      }],
    });
  });

  it("marks a candidate ineligible when a required external-data file is missing", async () => {
    const value = repository();
    value.files = value.files.filter(file => file.path !== "onnx/model_q4f16.onnx_data");

    const result = await inspectModelFilePlan({
      repository: value,
      declarations: declarations(),
      cache: undefined,
      getModelFiles: async ({ dtype }) => registryFiles({ dtype }),
    });

    expect(result.cacheRevisionProvenance).toBe("not-observed");
    expect(result.candidates[0]).toMatchObject({
      candidateId: "webgpu-q4f16",
      eligibility: "ineligible",
      missingRequiredFileCount: 1,
      ineligibleReasons: ["missing required repository file: onnx/model_q4f16.onnx_data"],
    });
  });

  it("records one registry failure without hiding the remaining candidate plans", async () => {
    const result = await inspectModelFilePlan({
      repository: repository(),
      declarations: declarations(),
      cache: cache(),
      getModelFiles: async ({ device, dtype }) => {
        if (device === "webgpu" && dtype === "q4f16") throw new Error("unsupported session layout");
        return registryFiles({ dtype });
      },
    });

    expect(result.candidates[0]).toMatchObject({
      candidateId: "webgpu-q4f16",
      registryStatus: "failed",
      registryError: "unsupported session layout",
      eligibility: "registry-failed",
    });
    expect(result.candidates[1]?.eligibility).toBe("eligible");
    expect(result.candidates[2]?.eligibility).toBe("eligible");
  });

  it("classifies Registry paths without treating optional configs as required model data", () => {
    expect(TEST_ONLY.fileKind({ path: "config.json" })).toBe("config");
    expect(TEST_ONLY.fileKind({ path: "onnx/model_q4.onnx" })).toBe("core-onnx");
    expect(TEST_ONLY.fileKind({ path: "onnx/model_q4.onnx_data_2" })).toBe("external-data");
    expect(TEST_ONLY.fileKind({ path: "generation_config.json" })).toBe("optional-config");
  });
});
