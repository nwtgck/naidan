import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationEvidencePackageAssessment,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import { createPartialModelSupportEvidence } from "./create-partial-evidence";

describe("createPartialModelSupportEvidence", () => {
  it("exports factual partial evidence and preserves not-run stages", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "run-1",
      modelId: "hf.co/org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:00:01.000Z",
      status: "passed",
      currentOperation: "verified",
      steps: [
        { id: "runtime-assets", status: "passed", detail: "verified" },
        { id: "repository-information", status: "not-run", detail: undefined },
        { id: "existing-model-data", status: "not-run", detail: undefined },
        { id: "model-declarations", status: "passed", detail: "declarations collected" },
        { id: "template-behavior", status: "passed", detail: "template evidence collected" },
        { id: "model-file-plan", status: "passed", detail: "model file plans collected" },
        { id: "loading-investigation", status: "not-run", detail: undefined },
        { id: "evidence-export", status: "not-run", detail: undefined },
      ],
      runtimeAssets: {
        variant: "asyncify",
        baseUrl: "https://naidan.example/transformers/",
        mjsUrl: "https://naidan.example/transformers/ort.mjs",
        wasmUrl: "https://naidan.example/transformers/ort.wasm",
        wasmByteLength: 4,
        mjsOrigin: "https://naidan.example",
        wasmOrigin: "https://naidan.example",
        applicationOrigin: "https://naidan.example",
        environment: {
          userAgent: "Browser/1",
          vendor: "Vendor",
          hardwareConcurrency: 8,
          deviceMemoryGiB: 16,
          crossOriginIsolated: true,
          webGpu: {
            availability: "available",
            adapterInfo: { vendor: "GPU Vendor" },
            features: ["shader-f16"],
            limits: { maxBufferSize: 1024 },
            error: undefined,
          },
        },
        control: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443",
          executionProvider: "wasm",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
        },
        webGpuControl: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443",
          executionProvider: "webgpu",
          status: "passed",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        },
      },
      repository: {
        requestedModelId: "hf.co/org/model",
        normalizedModelId: "org/model",
        requestedRevision: "main",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        fileCount: 0,
        files: [],
        pipelineTag: undefined,
        libraryName: undefined,
        metadata: {},
      },
      cache: {
        normalizedModelId: "org/model",
        rootPath: "models/huggingface.co/org/model",
        exists: false,
        revisionProvenance: "unknown",
        revisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
        totalBytes: 0,
        fileCount: 0,
        completionMarkerCount: 0,
        incompleteFileCount: 0,
        orphanCompletionMarkerCount: 0,
        orphanCompletionMarkerPaths: [],
        zeroByteFileCount: 0,
        weightFileCount: 0,
        allFilesHaveCompletionMarkers: false,
        files: [],
        provenance: {
          schemaVersion: 1,
          method: "bounded-range-sha256-v1",
          resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          rangeBytes: 32 * 1024,
          maximumFileCount: 3,
          status: "not-observed",
          confidence: "none",
          files: [],
          reason: "No exact-revision cache file was eligible for bounded sampling",
        },
      },
      declarations: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        files: [],
        config: { model_type: "new_chat_model" },
        modelType: "new_chat_model",
        architectures: ["NewChatForCausalLM"],
        autoMap: undefined,
        transformersJsConfig: undefined,
        classCapabilities: [{
          autoClass: "AutoModelForCausalLM",
          supports: true,
          notEvaluatedReason: undefined,
        }],
      },
      templateBehavior: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        tokenizerClass: "ProbeTokenizer",
        declaredChatTemplate: "{{ messages }}",
        cases: [],
      },
      modelFilePlan: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        modelType: "new_chat_model",
        registrySource: "ModelRegistry.get_model_files",
        cacheRevisionProvenance: "unknown",
        cacheRevisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
        candidates: [],
      },
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, error: undefined },
      laneComparison: undefined,
      error: undefined,
    };

    const { blob, fileName } = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const parsed = JSON.parse(await archive.file("run.json")!.async("text"));

    expect(fileName).toContain("hf.co-org-model");
    expect(archive.file("SUMMARY.md")).not.toBeNull();
    expect(archive.file("READINESS.md")).not.toBeNull();
    expect(archive.file("PACKAGE.md")).not.toBeNull();
    expect(archive.file("package-assessment.json")).not.toBeNull();
    expect(archive.file("readiness.json")).not.toBeNull();
    expect(archive.file("questions.json")).not.toBeNull();
    expect(archive.file("manifest.json")).not.toBeNull();
    expect(archive.file("errors.json")).not.toBeNull();
    expect(archive.file("events.jsonl")).not.toBeNull();
    expect(archive.file("support-boundaries.json")).not.toBeNull();
    expect(archive.file("runtime-assets/preflight.json")).not.toBeNull();
    expect(archive.file("runtime-assets/environment.json")).not.toBeNull();
    expect(archive.file("runtime-assets/backend-controls.json")).not.toBeNull();
    expect(archive.file("repository/repository.json")).not.toBeNull();
    expect(archive.file("cache/inventory.json")).not.toBeNull();
    expect(archive.file("cache/provenance.json")).not.toBeNull();
    expect(archive.file("repository/declarations.json")).not.toBeNull();
    expect(archive.file("runtime-assets/class-capabilities.json")).not.toBeNull();
    expect(archive.file("template-behavior/matrix.json")).not.toBeNull();
    expect(archive.file("model-files/plans.json")).not.toBeNull();
    expect(parsed.steps[1].status).toBe("not-run");
    expect(archive.file("load-attempts/index.json")).toBeNull();
    expect(archive.file("protocol-probes/tool.json")).toBeNull();
    const packageAssessment = JSON.parse(
      await archive.file("package-assessment.json")!.async("text"),
    ) as ModelSupportInvestigationEvidencePackageAssessment;
    expect(packageAssessment.status).not.toBe("invalid");
    expect(packageAssessment.missingRequiredCoreFiles).toEqual([]);
    expect(packageAssessment.missingReferencedEvidencePaths).toEqual([]);
    expect(await archive.file("SUMMARY.md")!.async("text")).toContain(`Package self-assessment: ${packageAssessment.status}`);
    const manifest = JSON.parse(await archive.file("manifest.json")!.async("text"));
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: "run.json",
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
    const runText = await archive.file("run.json")!.async("text");
    const runDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runText));
    const expectedRunSha256 = [...new Uint8Array(runDigest)]
      .map(value => value.toString(16).padStart(2, "0"))
      .join("");
    expect(manifest.files.find((item: { path: string }) => item.path === "run.json").sha256).toBe(expectedRunSha256);
    expect(manifest.files.some((item: { path: string }) => item.path === "manifest.json")).toBe(false);
    const archivePaths = Object.entries(archive.files)
      .filter(([path, file]) => path !== "manifest.json" && !file.dir)
      .map(([path]) => path)
      .sort();
    expect(manifest.files.map((item: { path: string }) => item.path).sort()).toEqual(archivePaths);
    for (const item of manifest.files as Array<{ path: string, byteLength: number, sha256: string }>) {
      const file = archive.file(item.path);
      expect(file, `manifest path ${item.path}`).not.toBeNull();
      const bytes = await file!.async("uint8array");
      expect(bytes.byteLength, item.path).toBe(item.byteLength);
      const digestInput = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(digestInput).set(bytes);
      const digest = await crypto.subtle.digest("SHA-256", digestInput);
      const sha256 = [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256, item.path).toBe(item.sha256);
    }
    const questions = JSON.parse(await archive.file("questions.json")!.async("text"));
    expect(questions).toContainEqual(expect.objectContaining({ domainId: "runtime-assets" }));
    const supportBoundaries = JSON.parse(await archive.file("support-boundaries.json")!.async("text"));
    const referencedPaths = [
      ...questions.flatMap((question: { evidencePaths: string[] }) => question.evidencePaths),
      ...supportBoundaries.flatMap((assessment: { evidencePaths: string[], contradictoryEvidencePaths: string[] }) => [
        ...assessment.evidencePaths,
        ...assessment.contradictoryEvidencePaths,
      ]),
    ];
    for (const path of referencedPaths) expect(archive.file(path), path).not.toBeNull();
  });

  it("exports each real-model load attempt and updates the factual summary", async () => {
    const run = {
      schemaVersion: 1,
      runId: "run-load",
      modelId: "org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files-load",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      status: "passed",
      currentOperation: "Minimum real-model generation evidence collected",
      steps: [],
      runtimeAssets: undefined,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [{
        attemptId: "attempt/1",
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        autoClass: "AutoModelForCausalLM",
        resolvedRevision: "a".repeat(40),
        startedAt: "2026-08-06T00:00:10.000Z",
        completedAt: "2026-08-06T00:00:20.000Z",
        status: "failed",
        failureStage: "model-load",
        events: [{
          stage: "model-load",
          status: "failed",
          detail: "model load failed",
          at: "2026-08-06T00:00:15.000Z",
        }],
        inputTokenCount: 2,
        inputTokenIds: [1, 2],
        inputTensors: [],
        loadedModel: undefined,
        generatedTokenIds: [42],
        generatedText: "answer",
        naturalGeneration: undefined,
        toolProtocolProbe: undefined,
        postAttemptCache: {
          status: "observed",
          inventory: {
            normalizedModelId: "org/model",
            rootPath: "models/huggingface.co/org/model",
            exists: true,
            revisionProvenance: "unknown",
            revisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
            totalBytes: 64,
            fileCount: 1,
            completionMarkerCount: 1,
            incompleteFileCount: 0,
            orphanCompletionMarkerCount: 0,
            orphanCompletionMarkerPaths: [],
            zeroByteFileCount: 0,
            weightFileCount: 1,
            allFilesHaveCompletionMarkers: true,
            files: [{
              path: "onnx/model_q4.onnx",
              repositoryPath: "onnx/model_q4.onnx",
              size: 64,
              lastModified: 1,
              hasCompletionMarker: true,
              isWeightFile: true,
            }],
          },
          requiredFileCoverage: {
            expectedPaths: ["onnx/model_q4.onnx"],
            completePaths: ["onnx/model_q4.onnx"],
            incompletePaths: [],
            missingPaths: [],
            revisionProvenance: "unknown",
          },
        },
        modelType: "llama",
        error: {
          name: "Error",
          message: "model load failed",
          stack: "stack",
        },
      }],
      productionLane: { status: "not-run", observation: undefined, error: undefined },
      laneComparison: undefined,
      error: undefined,
    } satisfies ModelSupportInvestigationRun;

    const { blob } = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const summary = await archive.file("SUMMARY.md")!.async("text");

    expect(archive.file("load-attempts/index.json")).not.toBeNull();
    expect(archive.file("load-attempts/attempt-1.json")).not.toBeNull();
    expect(summary).toContain("1 real-model load attempt was recorded");
    expect(summary).not.toContain("Model loading, generation, and continuity stages marked not-run");
    const errors = JSON.parse(await archive.file("errors.json")!.async("text"));
    expect(errors.loadAttemptErrors).toContainEqual(expect.objectContaining({
      attemptId: "attempt/1",
      failureStage: "model-load",
    }));
    expect(await archive.file("events.jsonl")!.async("text")).toContain('"attemptId":"attempt/1"');
    const attempt = JSON.parse(await archive.file("load-attempts/attempt-1.json")!.async("text"));
    expect(attempt.postAttemptCache).toEqual(expect.objectContaining({
      status: "observed",
      inventory: expect.objectContaining({ fileCount: 1, completionMarkerCount: 1 }),
      requiredFileCoverage: {
        expectedPaths: ["onnx/model_q4.onnx"],
        completePaths: ["onnx/model_q4.onnx"],
        incompletePaths: [],
        missingPaths: [],
        revisionProvenance: "unknown",
      },
    }));
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "cache",
      status: "partial",
    }));

    const [sourceAttempt] = run.loadAttempts;
    if (sourceAttempt === undefined) throw new Error("Expected a load attempt fixture");
    const failedCacheRun: ModelSupportInvestigationRun = {
      ...run,
      runId: "run-load-cache-inspection-failed",
      loadAttempts: [{
        ...sourceAttempt,
        postAttemptCache: {
          status: "failed",
          error: { name: "CacheInspectionError", message: "post-load cache inspection failed", stack: undefined },
        },
      }],
    };
    const { blob: failedCacheBlob } = await createPartialModelSupportEvidence({ run: failedCacheRun, recovery: undefined });
    const failedCacheArchive = await JSZip.loadAsync(await failedCacheBlob.arrayBuffer());
    const failedCacheErrors = JSON.parse(await failedCacheArchive.file("errors.json")!.async("text"));
    expect(failedCacheErrors.postAttemptCacheErrors).toContainEqual(expect.objectContaining({
      attemptId: "attempt/1",
      candidateId: "webgpu-q4",
      error: expect.objectContaining({ name: "CacheInspectionError" }),
    }));
  });

  it("exports Production Lane observations and Reference token comparison as separate primary evidence", async () => {
    const base = {
      schemaVersion: 1,
      runId: "run-lanes",
      modelId: "org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files-load-lanes",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      status: "passed",
      currentOperation: "Lane comparison evidence collected",
      steps: [],
      runtimeAssets: undefined,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [{
        attemptId: "reference-attempt",
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        autoClass: "AutoModelForCausalLM",
        resolvedRevision: "a".repeat(40),
        startedAt: "2026-08-06T00:00:10.000Z",
        completedAt: "2026-08-06T00:00:20.000Z",
        status: "passed",
        failureStage: undefined,
        events: [],
        inputTokenCount: 2,
        inputTokenIds: [1, 2],
        inputTensors: [],
        loadedModel: undefined,
        generatedTokenIds: [3],
        generatedText: "reference",
        naturalGeneration: undefined,
        toolProtocolProbe: {
          status: "observed",
          forced: true,
          source: "chat-template-render",
          generationCaseId: "tools-generation",
          assistantToolCallCaseId: "assistant-tool-call-history",
          toolResultContinuationCaseId: "tool-result-continuation",
          inputTokenIds: [1, 2],
          forcedTokenIds: [3, 4],
          generatedTokenIds: [3, 4],
          generatedText: "tool call",
          exactMatch: true,
          firstMismatchIndex: undefined,
          termination: "complete-forced-sequence",
          parserObservation: {
            status: "observed",
            strategy: "standard",
            parserKind: "standard-tool-call-stream-parser",
            inputMode: "production-text-streamer-reconstruction",
            inputChunks: ["<tool_call>{\"name\":\"lookup_weather\",\"arguments\":{}}</tool_call>"],
            visibleText: "",
            callBoundaryCount: undefined,
            toolCalls: [{ name: "lookup_weather", arguments: "{}" }],
            recognized: true,
          },
        },
        modelType: "model",
        error: undefined,
      }],
      productionLane: {
        status: "passed",
        observation: {
          modelId: "org/model",
          resolvedRevision: "a".repeat(40),
          candidate: { device: "webgpu", dtype: "q4" },
          route: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "model" },
          isEncoderDecoder: false,
          messages: [{ role: "user", content: "hello" }],
          inputKeys: ["input_ids"],
          inputTensors: [],
          inputTokenIds: [1, 2],
          pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [1, 2, 4],
          generatedTokenIds: [4],
          generatedText: "production",
          streamChunks: ["production"],
          toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
          continuity: {
            status: "failed",
            assistantMessage: { role: "assistant", content: "production" },
            followUpMessage: { role: "user", content: "Continue with one short sentence." },
            error: { name: "FixtureContinuityError", message: "fixture second turn failed" },
          },
          toolResultContinuation: {
            status: "passed",
            source: "reference-parser-roundtrip",
            strategy: "standard",
            messages: [],
            expectedInputTokenIds: [50, 51, 52],
            inputTokenExactMatch: true,
            firstInputMismatchIndex: undefined,
            turn: {
              messages: [],
              inputKeys: ["input_ids"],
              inputTensors: [],
              inputTokenIds: [50, 51, 52],
              pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [50, 51, 52, 60],
              generatedTokenIds: [60],
              generatedText: "continued",
              streamChunks: ["continued"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
          },
          reasoning: {
            status: "observed",
            source: "existing-production-strategy",
            strategy: "qwen3_5",
            disabledEffort: "none",
            enabledEffort: "high",
            disabledTurn: {
              messages: [], inputKeys: ["input_ids"], inputTensors: [], inputTokenIds: [70, 0], pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [70, 0, 80], generatedTokenIds: [80], generatedText: "none", streamChunks: ["none"], toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
            enabledTurn: {
              messages: [], inputKeys: ["input_ids"], inputTensors: [], inputTokenIds: [70, 1], pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [70, 1, 81], generatedTokenIds: [81], generatedText: "high", streamChunks: ["high"], toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
            inputTokenExactMatch: false,
            firstInputMismatchIndex: 1,
          },
          multimodal: {
            status: "observed",
            source: "fixed-synthetic-fixture-and-existing-production-strategy",
            strategy: "gemma4",
            fixture: {
              fixtureId: "single-transparent-pixel-png-v1",
              sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
              mimeType: "image/png",
              width: 1,
              height: 1,
              byteLength: 68,
              generationMethod: "embedded-fixed-png-bytes",
              prompt: "Describe the single synthetic image in one short phrase.",
              maxNewTokens: 1,
            },
            turn: {
              messages: [],
              inputKeys: ["input_ids", "pixel_values"],
              inputTensors: [
                { name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" },
                { name: "pixel_values", dtype: "float32", dims: [1, 3, 1, 1], location: "gpu-buffer" },
              ],
              inputTokenIds: [7, 8],
              pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [7, 8, 99],
              generatedTokenIds: [99],
              generatedText: "image",
              streamChunks: ["image"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 1, temperature: 0, topP: 1, doSample: false },
            },
          },
        },
        error: undefined,
      },
      laneComparison: {
        scenarioCaseId: "user-generation",
        referenceAttemptId: "reference-attempt",
        exactInputMatch: true,
        firstInputMismatchIndex: undefined,
        referenceInputTokenIds: [1, 2],
        productionInputTokenIds: [1, 2],
        referenceGeneratedTokenIds: [3],
        productionGeneratedTokenIds: [4],
        productionRoute: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "model" },
      },
      error: undefined,
    } satisfies ModelSupportInvestigationRun;

    const { blob } = await createPartialModelSupportEvidence({ run: base, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(archive.file("production-lane/observation.json")).not.toBeNull();
    expect(archive.file("production-lane/tool-result-continuation.json")).not.toBeNull();
    expect(archive.file("production-lane/reasoning.json")).not.toBeNull();
    expect(archive.file("production-lane/multimodal.json")).not.toBeNull();
    expect(archive.file("production-lane/error.json")).toBeNull();
    expect(archive.file("lane-comparison/comparison.json")).not.toBeNull();
    expect(archive.file("protocol-probes/tool.json")).not.toBeNull();
    const toolProbes = JSON.parse(await archive.file("protocol-probes/tool.json")!.async("text"));
    expect(toolProbes).toContainEqual(expect.objectContaining({
      attemptId: "reference-attempt",
      probe: expect.objectContaining({
        status: "observed",
        assistantToolCallCaseId: "assistant-tool-call-history",
        forcedTokenIds: [3, 4],
        exactMatch: true,
      }),
    }));
    expect(await archive.file("SUMMARY.md")!.async("text")).toContain("Production Lane passed with standard strategy");
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "production-routing",
      status: "implementation-ready",
    }));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "multimodal",
      status: "partial",
    }));
  });

  it("exports parent checkpoint recovery events and interruption evidence", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "interrupted-run",
      modelId: "org/model",
      scope: "partial-runtime-preflight",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:02.000Z",
      status: "failed",
      currentOperation: "Investigation interrupted after runtime-assets: Importing runtime",
      steps: [
        { id: "runtime-assets", status: "failed", detail: "Interrupted: Worker exited unexpectedly" },
        { id: "repository-information", status: "not-run", detail: undefined },
        { id: "existing-model-data", status: "not-run", detail: undefined },
        { id: "model-declarations", status: "not-run", detail: undefined },
        { id: "template-behavior", status: "not-run", detail: undefined },
        { id: "model-file-plan", status: "not-run", detail: undefined },
        { id: "loading-investigation", status: "not-run", detail: undefined },
        { id: "lane-comparison", status: "not-run", detail: undefined },
        { id: "evidence-export", status: "not-run", detail: undefined },
      ],
      runtimeAssets: undefined,
      repository: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, error: undefined },
      laneComparison: undefined,
      error: "Investigation interrupted: Worker exited unexpectedly",
    };
    const recovery = {
      schemaVersion: 1 as const,
      status: "interrupted" as const,
      checkpointSequence: 2,
      checkpointedAt: "2026-08-07T00:00:02.000Z",
      lastEvent: {
        sequence: 1,
        at: "2026-08-07T00:00:01.000Z",
        stepId: "runtime-assets" as const,
        status: "running" as const,
        detail: "Importing runtime",
      },
      events: [{
        sequence: 1,
        at: "2026-08-07T00:00:01.000Z",
        stepId: "runtime-assets" as const,
        status: "running" as const,
        detail: "Importing runtime",
      }],
      interruption: {
        at: "2026-08-07T00:00:02.000Z",
        lastEventSequence: 1,
        error: {
          name: "Error",
          message: "Worker exited unexpectedly",
          stack: undefined,
        },
      },
    };

    const { blob } = await createPartialModelSupportEvidence({ run, recovery });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const checkpoint = JSON.parse(await archive.file("recovery/checkpoint.json")!.async("text"));
    const errors = JSON.parse(await archive.file("errors.json")!.async("text"));
    const events = await archive.file("events.jsonl")!.async("text");
    const summary = await archive.file("SUMMARY.md")!.async("text");

    expect(checkpoint.status).toBe("interrupted");
    expect(errors.interruptionError).toMatchObject({ name: "Error", message: "Worker exited unexpectedly" });
    expect(events).toContain('"eventKind":"investigation-event"');
    expect(events).toContain('"detail":"Importing runtime"');
    expect(summary).toContain("Recovery status: interrupted");
  });

});
