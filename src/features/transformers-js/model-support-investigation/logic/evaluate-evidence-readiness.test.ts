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
      applicationOrigin: "https://naidan.example",
      mjsOrigin: "https://naidan.example",
      wasmOrigin: "https://naidan.example",
      control: { inputValue: 7, outputValue: 7 },
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
      naturalGeneration: { generatedTokenIds: [43, 44] },
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
    productionLane: { status: "not-run", observation: undefined, error: undefined },
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
        error: "tool continuation unsupported",
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
        messages: [{ role: "user", content: "hello" }],
        inputKeys: ["input_ids"],
        inputTensors: [],
        inputTokenIds: [1, 2],
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
      "lane-comparison/comparison.json",
    ]);
    expect(production?.questions[0]?.answer).toContain("input tokens match exactly");
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
