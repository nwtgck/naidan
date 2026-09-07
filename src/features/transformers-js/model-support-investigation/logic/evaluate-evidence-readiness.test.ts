import { describe, expect, it } from "vitest";
import type {
  ModelSupportInvestigationRun,
  ModelSupportInvestigationTemplateCase,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  evaluateEvidenceReadiness,
  renderEvidenceReadinessMarkdown,
} from "@/features/transformers-js/model-support-investigation/logic/evaluate-evidence-readiness";

function run(): ModelSupportInvestigationRun {
  return {
    runtimeAssets: {
      assetIdentity: {
        manifestBuildId: "runtime-build-fixture",
        manifestUrl: "https://naidan.example/transformers/runtime-assets-runtime-build-fixture.json",
        observedManifestBuildId: "runtime-build-fixture",
        versions: {
          transformers: "4.2.0",
          onnxRuntimeWeb: "1.26.0-dev.20260416-b7804b056c",
          onnxRuntimeCommon: "1.24.3",
          onnxRuntimeWebBundledCommon: "1.24.0-dev.20251116-b39e144322",
        },
        mjs: {
          url: "https://naidan.example/transformers/ort-fixture.mjs",
          expectedByteLength: 11,
          observedByteLength: 11,
          expectedSha256: "m".repeat(64),
          observedSha256: "m".repeat(64),
        },
        wasm: {
          logicalUrl: "https://naidan.example/transformers/ort-fixture.wasm",
          physicalUrl: "https://naidan.example/transformers/ort-fixture.wasm.gz",
          expectedByteLength: 12,
          observedByteLength: 12,
          expectedSha256: "w".repeat(64),
          observedSha256: "w".repeat(64),
          expectedPhysicalByteLength: 8,
          observedPhysicalByteLength: 8,
          expectedPhysicalSha256: "g".repeat(64),
          observedPhysicalSha256: "g".repeat(64),
        },
      },
      applicationOrigin: "https://naidan.example",
      mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example",
      control: { status: "passed", inputValue: 7, outputValue: 7 },
    },
    repository: { resolvedRevision: "a".repeat(40) },
    cache: {
      revisionProvenanceReason: "Completion markers do not independently prove file bytes",
      provenance: {
        status: "bounded-samples-matched",
        files: [{ status: "bounded-samples-matched" }],
      },
    },
    declarations: {
      fileFailures: [],
      modelType: "new_chat_model",
      classCapabilities: [{ autoClass: "AutoModelForCausalLM", supports: true }],
    },
    templateBehavior: {
      cases: [
        { caseId: "user-generation", status: "passed", inputIds: [1, 2] },
        { caseId: "tool-result-continuation", status: "passed", inputIds: [3, 4, 5] },
      ],
      toolTemplateProvenance: {
        status: "observed",
        source: "chat-template-render",
        generationCaseId: "tools-generation",
        assistantToolCallCaseId: "assistant-tool-call-history",
        toolResultContinuationCaseId: "tool-result-continuation",
        generationInputIds: [3, 4],
        assistantToolCallInputIds: [3, 4, 5],
        toolResultContinuationInputIds: [3, 4, 5],
        generationPromptPrefixMatch: true,
        firstMismatchIndex: undefined,
        assistantToolCallSuffixTokenIds: [5],
      },
    },
    modelFilePlan: {
      candidates: [{ candidateId: "webgpu-q4", eligibility: "eligible" }],
    },
    loadAttempts: [{
      attemptId: "attempt-1",
      candidateId: "webgpu-q4",
      status: "passed",
      loadedModel: {
        sessions: [{ name: "model", inputNames: ["input_ids"], outputNames: ["logits"] }],
        sessionFileCorrelations: [{
          sessionName: "model",
          status: "exact",
          matchBasis: "exact-session-name-to-core-onnx-basename",
          coreFilePaths: ["onnx/model.onnx"],
          externalDataPaths: [],
        }],
      },
      inputTensors: [{ name: "input_ids" }],
      generatedTokenIds: [42],
      naturalGeneration: { status: "observed", generatedTokenIds: [43, 44] },
      postAttemptCache: {
        status: "observed",
        inventory: {
          fileCount: 4,
          completionMarkerCount: 4,
          incompleteFileCount: 0,
          revisionProvenance: "unknown",
        },
        requiredFileCoverage: {
          expectedPaths: ["onnx/model.onnx"],
          completePaths: ["onnx/model.onnx"],
          sizeMismatchPaths: [],
          incompletePaths: [],
          missingPaths: [],
          revisionProvenance: "unknown",
        },
      },
      toolProtocolProbe: {
        status: "observed",
        forced: true,
        source: "chat-template-render",
        generationCaseId: "tools-generation",
        assistantToolCallCaseId: "assistant-tool-call-history",
        toolResultContinuationCaseId: "tool-result-continuation",
        inputTokenIds: [3, 4],
        forcedTokenIds: [5],
        generatedTokenIds: [5],
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
        toolResultTemplateRoundTrip: {
          status: "observed",
          source: "recognized-production-parser-and-chat-template",
          parserStrategy: "standard",
          toolCall: { name: "lookup_weather", arguments: "{}" },
          toolResultContent: '{"temperatureC":20,"condition":"clear"}',
          selectedTemplate: "tool template",
          renderedText: "tool result continuation",
          inputTokenIds: [6, 7, 8],
        },
      },
    }],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
  } as unknown as ModelSupportInvestigationRun;
}

describe("evaluateEvidenceReadiness", () => {
  it("marks observed implementation domains ready without claiming unobserved capabilities", () => {
    const report = evaluateEvidenceReadiness({ run: run() });

    expect(report.overall).toBe("partial");
    expect(report.domains.find(item => item.domainId === "runtime-assets")?.status).toBe("implementation-ready");
    expect(report.domains.find(item => item.domainId === "runtime-load")?.status).toBe("implementation-ready");
    const cache = report.domains.find(item => item.domainId === "cache");
    expect(cache?.status).toBe("partial");
    expect(cache?.questions[0]?.answer).toContain("post-attempt inventory: files=4, complete markers=4");
    expect(cache?.questions[0]?.evidencePaths).toContain("load-attempts/index.json");
    expect(cache?.questions[0]?.evidencePaths).toContain("cache/provenance.json");
    expect(cache?.questions[0]?.answer).toContain("bounded samples matched");
    expect(report.domains.find(item => item.domainId === "plain-text")?.status).toBe("implementation-ready");
    expect(report.domains.find(item => item.domainId === "continuity-kv-cache")?.status).toBe("not-observed");
    const tools = report.domains.find(item => item.domainId === "tools");
    expect(tools?.status).toBe("partial");
    expect(tools?.questions.some(question => question.answer.includes("forced tokens matched exactly"))).toBe(true);
    expect(tools?.summary).toContain("production parser recognized 1 tool call(s)");
    expect(tools?.summary).toContain("re-rendered into 3 continuation token(s)");
    expect(renderEvidenceReadinessMarkdown({ report })).toContain("Evidence: load-attempts/index.json");
  });


  it("keeps runtime readiness insufficient when runtime asset identity is unavailable", () => {
    const value = run();
    if (value.runtimeAssets === undefined) throw new Error("Runtime-assets fixture is unavailable");
    value.runtimeAssets.assetIdentity = undefined;

    const runtime = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "runtime-assets");

    expect(runtime).toMatchObject({ status: "insufficient" });
    expect(runtime?.questions[0]?.answer).toContain("Runtime asset identity");
  });

  it("keeps model declaration readiness partial when optional declaration files fail", () => {
    const value = run();
    value.declarations!.fileFailures = [{
      path: "tokenizer_config.json",
      url: "https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/tokenizer_config.json",
      error: {
        name: "Error",
        message: "Hugging Face declaration tokenizer_config.json resolved to HTML instead of JSON",
        stack: undefined,
      },
    }];

    const report = evaluateEvidenceReadiness({ run: value });

    expect(report.domains.find(item => item.domainId === "model-declarations")).toMatchObject({
      status: "partial",
      summary: expect.stringContaining("1 optional declaration files failed"),
    });
  });

  it("preserves successful model-load readiness when deterministic input construction fails", () => {
    const value = run();
    const attempt = value.loadAttempts[0];
    if (attempt === undefined) throw new Error("Load-attempt fixture is unavailable");
    attempt.status = "failed";
    attempt.failureStage = "input-build";
    attempt.inputTensors = [];
    attempt.generatedTokenIds = [];
    attempt.naturalGeneration = undefined;
    attempt.error = {
      name: "TemplateInputUnavailableError",
      message: "deterministic input unavailable",
      stack: undefined,
    };

    const report = evaluateEvidenceReadiness({ run: value });
    const runtimeLoad = report.domains.find(item => item.domainId === "runtime-load");
    expect(runtimeLoad).toMatchObject({ status: "implementation-ready" });
    expect(runtimeLoad?.questions[0]).toMatchObject({ questionId: "real-model-load-and-session-files" });
    expect(runtimeLoad?.questions[0]?.answer).toContain("model loaded");
    expect(report.domains.find(item => item.domainId === "plain-text")?.status).toBe("not-observed");
  });


  it("keeps Production plain-text evidence when all Reference input strategies fail", () => {
    const value = run();
    const attempt = value.loadAttempts[0];
    if (attempt === undefined) throw new Error("Load-attempt fixture is unavailable");
    attempt.status = "failed";
    attempt.failureStage = "first-generation";
    attempt.inputStrategyAttempts = [{
      strategy: "chat-template-tensor-dict",
      status: "failed",
      failureStage: "first-generation",
      inputTokenIds: [1, 2],
      inputTensors: [{ name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" }],
      error: { name: "TypeError", message: "adapter rejected input", stack: undefined },
    }, {
      strategy: "observed-token-ids-transformers-tensor",
      status: "failed",
      failureStage: "first-generation",
      inputTokenIds: [1, 2],
      inputTensors: [{ name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" }],
      error: { name: "TypeError", message: "fallback rejected input", stack: undefined },
    }];
    attempt.selectedInputStrategy = undefined;
    attempt.inputTensors = [];
    attempt.generatedTokenIds = [];
    attempt.naturalGeneration = undefined;
    value.productionLane = {
      status: "passed",
      observation: {
        route: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "new_chat_model" },
        firstTurn: { status: "passed", turn: { generatedTokenIds: [9, 10] } },
      } as never,
      error: undefined,
    };

    const plainText = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "plain-text");
    expect(plainText).toMatchObject({ status: "partial" });
    expect(plainText?.summary).toContain("Production Lane generated 2 token(s)");
    expect(plainText?.questions[0]?.evidencePaths).toEqual(["production-lane/observation.json"]);
  });

  it("marks a bounded cache sample mismatch insufficient without claiming whole-file comparison", () => {
    const value = run();
    value.cache!.provenance = {
      schemaVersion: 1,
      method: "bounded-range-sha256-v1",
      resolvedRevision: "a".repeat(40),
      rangeBytes: 32 * 1024,
      maximumFileCount: 3,
      status: "mismatched",
      confidence: "bounded-sample-mismatch",
      files: [{
        cachePath: `resolve/${"a".repeat(40)}/onnx/model_q4.onnx`,
        repositoryPath: "onnx/model_q4.onnx",
        cacheRevision: "a".repeat(40),
        localSize: 10,
        repositorySize: 10,
        status: "mismatched",
        ranges: [],
        reason: "bounded sample differed",
      }],
      reason: "At least one bounded sample differed",
    };

    const cache = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "cache");

    expect(cache).toMatchObject({ status: "insufficient" });
    expect(cache?.questions[0]?.answer).toContain("bounded sample mismatch detected");
  });

  it("links structured runtime failures from runtime readiness", () => {
    const value = run();
    value.runtimeAssets = undefined;
    value.runtimeAssetsPartial = {
      variant: "asyncify",
      baseUrl: "https://naidan.example/transformers/",
      mjsUrl: "https://naidan.example/transformers/ort.mjs",
      wasmUrl: "https://naidan.example/transformers/ort.wasm",
      physicalWasmUrl: "https://naidan.example/transformers/ort.wasm.gz",
      applicationOrigin: "https://naidan.example",
      mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example",
      physicalWasmOrigin: "https://naidan.example",
      environment: undefined,
      wasmByteLength: undefined,
      control: undefined,
      webGpuControl: undefined,
      currentStage: undefined,
      stageObservations: [{
        stage: "module-import",
        status: "failed",
        detail: "runtime module import failed",
        error: "runtime module import failed",
      }],
    };
    value.stepErrors = {
      "runtime-assets": [{
        name: "Error",
        message: "runtime module import failed",
        stack: "Error: runtime module import failed",
      }],
    };

    const runtime = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "runtime-assets");
    expect(runtime).toMatchObject({ status: "insufficient" });
    expect(runtime?.questions[0]?.evidencePaths).toEqual([
      "runtime-assets/preflight-partial.json",
      "errors.json",
    ]);
  });

  it("marks failed prerequisite inspections insufficient and links their structured errors", () => {
    const value = run();
    value.repository = undefined;
    value.cache = undefined;
    value.declarations = undefined;
    value.templateBehavior = undefined;
    value.modelFilePlan = undefined;
    const structuredError = {
      name: "TypeError",
      message: "fixture inspection failed",
      stack: `\
TypeError: fixture inspection failed
    at fixture`,
      thrownType: "TypeError",
      serializedOriginalThrownValue: '{"name":"TypeError"}',
      cause: undefined,
    };
    value.stepErrors = {
      "repository-information": [structuredError],
      "existing-model-data": [structuredError],
      "model-declarations": [structuredError],
      "template-behavior": [structuredError],
      "model-file-plan": [structuredError],
    };

    const report = evaluateEvidenceReadiness({ run: value });

    for (const domainId of [
      "repository",
      "cache",
      "model-declarations",
      "template-tokenizer",
      "model-file-plan",
    ] as const) {
      const readiness = report.domains.find(item => item.domainId === domainId);
      expect(readiness?.status).toBe("insufficient");
      expect(readiness?.questions[0]?.evidencePaths).toContain("errors.json");
    }
  });

  it("does not claim tool protocol provenance when the continuation template failed", () => {
    const value = run();
    const baseCase: Omit<ModelSupportInvestigationTemplateCase, "caseId" | "status" | "inputIds" | "failureStage" | "error"> = {
      messages: [{ role: "user", content: "fixture" }],
      tools: undefined,
      addGenerationPrompt: true,
      selectedTemplate: "default template",
      renderedText: "fixture",
    };
    const firstAttempt = value.loadAttempts[0];
    if (firstAttempt === undefined) throw new Error("Load-attempt fixture is unavailable");
    firstAttempt.toolProtocolProbe = {
      status: "unavailable",
      forced: false,
      source: "chat-template-render",
      generationCaseId: "tools-generation",
      assistantToolCallCaseId: "assistant-tool-call-history",
      toolResultContinuationCaseId: "tool-result-continuation",
      reason: "tool continuation unsupported",
    };
    value.templateBehavior!.toolTemplateProvenance = {
      status: "unavailable",
      source: "chat-template-render",
      generationCaseId: "tools-generation",
      assistantToolCallCaseId: "assistant-tool-call-history",
      toolResultContinuationCaseId: "tool-result-continuation",
      reason: "tool continuation unsupported",
    };
    value.templateBehavior!.cases = [
      {
        ...baseCase,
        caseId: "user-generation",
        status: "passed",
        inputIds: [1, 2],
        failureStage: undefined,
        error: undefined,
      },
      {
        ...baseCase,
        caseId: "tool-result-continuation",
        status: "failed",
        inputIds: undefined,
        failureStage: "template-selection",
        error: {
          name: "Error",
          message: "tool continuation unsupported",
          stack: undefined,
        },
      },
    ];

    const tools = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "tools");
    expect(tools).toMatchObject({ status: "not-observed" });
    expect(tools?.questions[0]?.evidencePaths).toEqual(["protocol-probes/tool.json", "load-attempts/index.json"]);
  });

  it("marks a failed runtime integrity preflight insufficient", () => {
    const value = run();
    value.runtimeAssets = {
      ...value.runtimeAssets!,
      wasmOrigin: "https://cdn.example",
    };
    const report = evaluateEvidenceReadiness({ run: value });

    expect(report.overall).toBe("insufficient");
    expect(report.domains.find(item => item.domainId === "runtime-assets")?.status).toBe("insufficient");
  });
  it("marks missing core runtime evidence insufficient rather than partial", () => {
    const value = run();
    value.runtimeAssets = undefined;
    const report = evaluateEvidenceReadiness({ run: value });

    expect(report.overall).toBe("insufficient");
    expect(report.domains.find(item => item.domainId === "runtime-assets")?.status).toBe("not-observed");
  });

  it("keeps continuity partial until the persistence serialization contract is observed", () => {
    const value = run();
    value.productionLane = {
      status: "running",
      observation: undefined,
      partialObservation: {
        route: {
          autoClass: "AutoModelForCausalLM",
          processor: "processor",
          strategy: "qwen3_5",
          modelType: "qwen3_5",
        },
        continuity: {
          status: "passed",
          secondTurn: {
            pastKeyValuesProvided: false,
            cacheDecision: { status: "not-reused", reason: "qwen3_5-message-count-mismatch" },
          },
          prefixComparison: {
            mode: "full-input-prefix",
            comparisonInputSource: "reconstructed-full-conversation",
            exactPrefixMatch: true,
            firstMismatchIndex: undefined,
          },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "continuity-kv-cache");
    expect(continuity).toMatchObject({ status: "partial" });
    expect(continuity?.questions[0]?.answer).toContain("qwen3_5-message-count-mismatch");
    expect(continuity?.questions[0]?.answer).toContain("preserved the exact prior model-token prefix");
    expect(continuity?.questions[0]?.answer).toContain("persistence mapper/DTO/JSON roundtrip was not observed");
  });

  it("marks continuity implementation-ready when exact prefix and persistence serialization evidence agree", () => {
    const value = run();
    value.persistenceRoundTrip = {
      status: 'observed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      modelVisibleProjectionMethod: 'build-chat-generation-messages-v1',
      serializedByteLength: 128,
      serializedSha256: 'b'.repeat(64),
      originalMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: true,
      firstMismatchIndex: undefined,
    };
    value.productionLane = {
      status: 'running', observation: undefined,
      partialObservation: {
        route: { autoClass: 'AutoModelForCausalLM', processor: 'processor', strategy: 'qwen3_5', modelType: 'qwen3_5' },
        continuity: {
          status: 'passed',
          secondTurn: { pastKeyValuesProvided: false, cacheDecision: { status: 'not-reused', reason: 'qwen3_5-message-count-mismatch' } },
          prefixComparison: {
            mode: 'full-input-prefix', comparisonInputSource: 'reconstructed-full-conversation',
            exactPrefixMatch: true, firstMismatchIndex: undefined,
          },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains.find(item => item.domainId === 'continuity-kv-cache');
    expect(continuity).toMatchObject({ status: 'implementation-ready' });
    expect(continuity?.questions[0]?.answer).toContain('preserved 1 model-visible synthetic messages exactly');
    expect(continuity?.questions[0]?.evidencePaths).toContain('continuity/persistence-roundtrip.json');
  });

  it('keeps legacy persistence evidence partial when Production history projection provenance is absent', () => {
    const value = run();
    value.persistenceRoundTrip = {
      status: 'observed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      serializedByteLength: 128,
      serializedSha256: 'b'.repeat(64),
      originalMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: true,
      firstMismatchIndex: undefined,
    };
    value.productionLane = {
      status: 'running',
      observation: undefined,
      partialObservation: {
        route: { autoClass: 'AutoModelForCausalLM', processor: 'processor', strategy: 'qwen3_5', modelType: 'qwen3_5' },
        continuity: {
          status: 'passed',
          secondTurn: { pastKeyValuesProvided: false, cacheDecision: { status: 'not-reused', reason: 'qwen3_5-message-count-mismatch' } },
          prefixComparison: {
            mode: 'full-input-prefix',
            comparisonInputSource: 'reconstructed-full-conversation',
            exactPrefixMatch: true,
            firstMismatchIndex: undefined,
          },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains.find(item => item.domainId === 'continuity-kv-cache');
    expect(continuity).toMatchObject({ status: 'partial' });
    expect(continuity?.summary).toContain('does not prove that the restored history passed through the same Production LM-message projection');
  });

  it("marks continuity insufficient when persistence serialization changes model-visible history", () => {
    const value = run();
    value.persistenceRoundTrip = {
      status: 'observed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      modelVisibleProjectionMethod: 'build-chat-generation-messages-v1',
      serializedByteLength: 128,
      serializedSha256: 'b'.repeat(64),
      originalMessages: [{ role: 'assistant', content: 'before', tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: 'assistant', content: 'after', tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: false,
      firstMismatchIndex: 0,
    };
    value.productionLane = {
      status: 'running', observation: undefined,
      partialObservation: {
        route: { autoClass: 'AutoModelForCausalLM', processor: 'processor', strategy: 'qwen3_5', modelType: 'qwen3_5' },
        continuity: {
          status: 'passed',
          secondTurn: { pastKeyValuesProvided: false, cacheDecision: { status: 'not-reused', reason: 'qwen3_5-message-count-mismatch' } },
          prefixComparison: {
            mode: 'full-input-prefix', comparisonInputSource: 'reconstructed-full-conversation',
            exactPrefixMatch: true, firstMismatchIndex: undefined,
          },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains.find(item => item.domainId === 'continuity-kv-cache');
    expect(continuity).toMatchObject({ status: 'insufficient' });
    expect(continuity?.summary).toContain('changed model-visible synthetic history');
  });

  it("marks continuity implementation-ready when exact prefix and persistence serialization evidence agree", () => {
    const value = run();
    value.persistenceRoundTrip = {
      status: "observed", fixtureId: "tool-call-history-v1", method: "chat-content-dto-json-roundtrip-v1",
      modelVisibleProjectionMethod: "build-chat-generation-messages-v1",
      serializedByteLength: 128, serializedSha256: "b".repeat(64),
      originalMessages: [{ role: "user", content: "fixture", tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: "user", content: "fixture", tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: true, firstMismatchIndex: undefined,
    };
    value.productionLane = {
      status: "running", observation: undefined,
      partialObservation: {
        route: { autoClass: "AutoModelForCausalLM", processor: "processor", strategy: "qwen3_5", modelType: "qwen3_5" },
        continuity: {
          status: "passed",
          secondTurn: { pastKeyValuesProvided: false, cacheDecision: { status: "not-reused", reason: "qwen3_5-message-count-mismatch" } },
          prefixComparison: { mode: "full-input-prefix", comparisonInputSource: "reconstructed-full-conversation", exactPrefixMatch: true, firstMismatchIndex: undefined },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains.find(item => item.domainId === "continuity-kv-cache");
    expect(continuity).toMatchObject({ status: "implementation-ready" });
    expect(continuity?.questions[0]?.answer).toContain("preserved 1 model-visible synthetic messages exactly");
    expect(continuity?.questions[0]?.evidencePaths).toContain("continuity/persistence-roundtrip.json");
  });

  it("marks continuity insufficient when persistence serialization changes model-visible history", () => {
    const value = run();
    value.persistenceRoundTrip = {
      status: "observed", fixtureId: "tool-call-history-v1", method: "chat-content-dto-json-roundtrip-v1",
      modelVisibleProjectionMethod: "build-chat-generation-messages-v1",
      serializedByteLength: 128, serializedSha256: "b".repeat(64),
      originalMessages: [{ role: "assistant", content: "before", tool_calls: undefined, tool_call_id: undefined }],
      restoredMessages: [{ role: "assistant", content: "after", tool_calls: undefined, tool_call_id: undefined }],
      exactModelVisibleMatch: false, firstMismatchIndex: 0,
    };
    value.productionLane = {
      status: "running", observation: undefined,
      partialObservation: {
        route: { autoClass: "AutoModelForCausalLM", processor: "processor", strategy: "qwen3_5", modelType: "qwen3_5" },
        continuity: {
          status: "passed",
          secondTurn: { pastKeyValuesProvided: false, cacheDecision: { status: "not-reused", reason: "qwen3_5-message-count-mismatch" } },
          prefixComparison: { mode: "full-input-prefix", comparisonInputSource: "reconstructed-full-conversation", exactPrefixMatch: true, firstMismatchIndex: undefined },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains.find(item => item.domainId === "continuity-kv-cache");
    expect(continuity).toMatchObject({ status: "insufficient" });
    expect(continuity?.summary).toContain("changed model-visible synthetic history");
  });

  it("marks continuity insufficient when the strategy cache decision contradicts the model.generate handoff", () => {
    const value = run();
    value.productionLane = {
      status: "running",
      observation: undefined,
      partialObservation: {
        route: {
          autoClass: "AutoModelForCausalLM",
          processor: "processor",
          strategy: "qwen3_5",
          modelType: "qwen3_5",
        },
        continuity: {
          status: "passed",
          secondTurn: {
            pastKeyValuesProvided: false,
            cacheDecision: { status: "reused", reason: "qwen3_5-no-tool-continuation" },
          },
          prefixComparison: {
            mode: "full-input-prefix",
            comparisonInputSource: "reconstructed-full-conversation",
            exactPrefixMatch: true,
            firstMismatchIndex: undefined,
          },
        },
      } as never,
      error: undefined,
    };

    const continuity = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "continuity-kv-cache");
    expect(continuity).toMatchObject({ status: "insufficient" });
    expect(continuity?.summary).toContain("contradict");
  });

  it("marks Production routing ready only with an observation and Reference token comparison", () => {
    const value = run();
    value.productionLane = {
      status: "passed",
      observation: {
        modelId: "org/model",
        resolvedRevision: "a".repeat(40),
        candidate: { device: "webgpu", dtype: "q4" },
        route: {
          autoClass: "AutoModelForCausalLM",
          processor: "tokenizer",
          strategy: "standard",
          modelType: "new_chat_model",
        },
        isEncoderDecoder: false,
        firstTurn: {
          status: "passed",
          turn: {
            messages: [{ role: "user", content: "hello" }],
            inputKeys: ["input_ids"],
            inputTensors: [],
            inputTokenIds: [1, 2],
            fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
            cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
            pastKeyValuesProvided: false,
            inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
            outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
            generatedSequenceTokenIds: [1, 2, 4],
            generatedTokenIds: [4],
            generatedText: "answer",
            streamChunks: ["answer"],
            toolCalls: [],
            effectiveGenerationConfig: {
              maxNewTokens: 16,
              temperature: 0,
              topP: 1,
              doSample: false,
            },
          },
        },
        continuity: {
          status: "failed",
          assistantMessage: { role: "assistant", content: "answer" },
          followUpMessage: { role: "user", content: "Continue with one short sentence." },
          error: { name: "FixtureContinuityError", message: "fixture second turn failed" },
        },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
        reasoning: { status: "unavailable", reason: "not a Qwen3.5 Production strategy" },
        multimodal: { status: "unavailable", strategy: "standard", reason: "standard Production strategy has no image processor" },
      },
      error: undefined,
    };
    const productionObservation = value.productionLane.observation;
    if (productionObservation === undefined) throw new Error("Production observation fixture is unavailable");
    value.laneComparison = {
      scenarioCaseId: "user-generation",
      referenceAttemptId: "attempt-1",
      exactInputMatch: true,
      firstInputMismatchIndex: undefined,
      referenceInputTokenIds: [1, 2],
      productionInputTokenIds: [1, 2],
      referenceGeneratedTokenIds: [42],
      productionGeneratedTokenIds: [4],
      productionRoute: productionObservation.route,
    };

    const report = evaluateEvidenceReadiness({ run: value });
    const production = report.domains.find(item => item.domainId === "production-routing");
    expect(production).toMatchObject({ status: "implementation-ready" });
    expect(production?.questions[0]?.evidencePaths).toEqual([
      "production-lane/observation.json",
      "production-lane/first-turn.json",
      "lane-comparison/comparison.json",
    ]);
    expect(production?.questions[0]?.answer).toContain("input tokens match exactly");
  });

  it("keeps Production routing partial after a first-turn failure while retaining independent probe evidence", () => {
    const value = run();
    value.productionLane = {
      status: "passed",
      observation: {
        modelId: "org/model",
        resolvedRevision: "a".repeat(40),
        candidate: { device: "webgpu", dtype: "q4" },
        route: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "qwen3_5", modelType: "qwen3_5" },
        isEncoderDecoder: false,
        firstTurn: { status: "failed", error: { name: "FixtureFirstTurnError", message: "first turn failed" } },
        continuity: { status: "not-run", reason: "First Production turn failed" },
        toolResultContinuation: { status: "not-run", reason: "not requested" },
        reasoning: {
          status: "observed",
          source: "existing-production-strategy",
          strategy: "qwen3_5",
          disabledEffort: "none",
          enabledEffort: "high",
          disabledTurn: { inputTokenIds: [7, 0] } as never,
          enabledTurn: { inputTokenIds: [7, 1] } as never,
          inputTokenExactMatch: false,
          firstInputMismatchIndex: 1,
        },
        multimodal: { status: "unavailable", strategy: "qwen3_5", reason: "not a multimodal route" },
      },
      error: undefined,
    };

    const report = evaluateEvidenceReadiness({ run: value });
    const production = report.domains.find(item => item.domainId === "production-routing");
    const continuity = report.domains.find(item => item.domainId === "continuity-kv-cache");
    const reasoning = report.domains.find(item => item.domainId === "reasoning");

    expect(production).toMatchObject({ status: "partial" });
    expect(production?.questions[0]?.answer).toContain("first turn failed");
    expect(continuity).toMatchObject({ status: "not-observed" });
    expect(reasoning).toMatchObject({ status: "partial" });
  });

  it("keeps a failed Production Lane partial while preserving its error evidence", () => {
    const value = run();
    value.productionLane = {
      status: "failed",
      observation: undefined,
      error: { name: "Error", message: "production failed", stack: undefined },
    };
    const production = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "production-routing");

    expect(production).toMatchObject({ status: "partial" });
    expect(production?.questions[0]).toMatchObject({
      answer: "production failed",
      evidencePaths: ["production-lane/error.json"],
    });
  });

  it("marks an observed Qwen3.5 Production reasoning differential as partial evidence", () => {
    const observedRun = run();
    observedRun.productionLane = {
      status: "passed",
      observation: {
        route: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "qwen3_5", modelType: "qwen3_5" },
        firstTurn: { status: "failed", error: { name: "FixtureError", message: "first turn not relevant to reasoning fixture" } },
        reasoning: {
          status: "observed",
          source: "existing-production-strategy",
          strategy: "qwen3_5",
          disabledEffort: "none",
          enabledEffort: "high",
          disabledTurn: { inputTokenIds: [7, 0] },
          enabledTurn: { inputTokenIds: [7, 1] },
          inputTokenExactMatch: false,
          firstInputMismatchIndex: 1,
        },
      } as never,
      error: undefined,
    };

    const report = evaluateEvidenceReadiness({ run: observedRun });
    const reasoning = report.domains.find(item => item.domainId === "reasoning");

    expect(reasoning).toMatchObject({ status: "partial" });
    expect(reasoning?.questions[0]).toMatchObject({
      evidencePaths: ["production-lane/reasoning.json"],
    });
    expect(reasoning?.questions[0]?.answer).toContain("firstMismatch=1");
  });

  it("marks a fixed Gemma 4 multimodal Production observation as partial evidence", () => {
    const value = run();
    value.productionLane = {
      status: "passed",
      observation: {
        route: { autoClass: "AutoModelForImageTextToText", processor: "gemma4-processor", strategy: "gemma4", modelType: "gemma4" },
        firstTurn: { status: "failed", error: { name: "FixtureError", message: "first turn not relevant to multimodal fixture" } },
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
            fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
            cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
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
      } as never,
      error: undefined,
    };

    const multimodal = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "multimodal");
    expect(multimodal).toMatchObject({ status: "partial" });
    expect(multimodal?.questions[0]).toMatchObject({
      evidencePaths: ["production-lane/multimodal.json"],
    });
    expect(multimodal?.questions[0]?.answer).toContain("single-transparent-pixel-png-v1");
    expect(multimodal?.questions[0]?.answer).toContain("pixel_values:float32[1x3x1x1]");
  });

  it("keeps unsupported Production multimodal routing not observed", () => {
    const value = run();
    value.productionLane = {
      status: "passed",
      observation: {
        route: { autoClass: "AutoModelForCausalLM", processor: "qwen3_5-processor", strategy: "qwen3_5", modelType: "qwen3_5" },
        firstTurn: { status: "failed", error: { name: "FixtureError", message: "first turn not relevant to multimodal fixture" } },
        multimodal: {
          status: "unavailable",
          strategy: "qwen3_5",
          reason: "current Production strategy serializes image parts as text",
        },
      } as never,
      error: undefined,
    };

    const multimodal = evaluateEvidenceReadiness({ run: value }).domains
      .find(item => item.domainId === "multimodal");
    expect(multimodal).toMatchObject({ status: "not-observed" });
    expect(multimodal?.questions[0]?.answer).toContain("unavailable");
  });

});
