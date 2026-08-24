import { describe, expect, it, vi } from "vitest";
import { runProductionLaneComparison } from "@/features/transformers-js/model-support-investigation/logic/run-production-lane-comparison";
import type { ModelSupportInvestigationRun } from "@/features/transformers-js/model-support-investigation/types";
import type { TransformersJsProductionInvestigationObservation } from "@/features/transformers-js/types";

const baseRun = {
  scope: "partial-runtime-repository-cache-declarations-template-model-files-load",
  status: "passed",
  completedAt: "before",
  currentOperation: "reference complete",
  error: undefined,
  steps: [{ id: "lane-comparison", status: "not-run", detail: undefined }],
  repository: { normalizedModelId: "org/model", resolvedRevision: "a".repeat(40) },
  templateBehavior: {
    cases: [{
      caseId: "user-generation",
      status: "passed",
      messages: [{ role: "user", content: "hello" }],
    }],
  },
  loadAttempts: [{
    attemptId: "attempt-1",
    candidateId: "webgpu-q4",
    device: "webgpu",
    dtype: "q4",
    status: "passed",
    inputTokenIds: [1, 2],
    generatedTokenIds: [3],
  }],
  productionLane: { status: "not-run", observation: undefined, error: undefined },
  laneComparison: undefined,
} as ModelSupportInvestigationRun;

const productionObservation = {
  modelId: "org/model",
  resolvedRevision: "a".repeat(40),
  candidate: { device: "webgpu", dtype: "q4" },
  route: {
    autoClass: "AutoModelForCausalLM",
    processor: "tokenizer",
    strategy: "standard",
    modelType: "example",
  },
  isEncoderDecoder: false,
  messages: [{ role: "user", content: "hello" }],
  inputKeys: ["input_ids"],
  inputTensors: [],
  inputTokenIds: [1, 2],
  pastKeyValuesProvided: false,
  inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
  outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
  generatedSequenceTokenIds: [1, 2, 4],
  generatedTokenIds: [4],
  generatedText: "answer",
  streamChunks: ["answer"],
  toolCalls: [],
  effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
  continuity: {
    status: "failed",
    assistantMessage: { role: "assistant", content: "answer" },
    followUpMessage: { role: "user", content: "Continue." },
    error: { name: "FixtureError", message: "not exercised" },
  },
  toolResultContinuation: { status: "not-run", reason: "not requested" },
  reasoning: { status: "unavailable", reason: "not a Qwen3.5 Production strategy" },
  multimodal: { status: "unavailable", strategy: "standard", reason: "standard Production strategy has no image processor" },
} satisfies TransformersJsProductionInvestigationObservation;

describe("runProductionLaneComparison", () => {
  it("reports the exact missing prerequisites when Production Lane is blocked", async () => {
    const run = structuredClone(baseRun);
    run.templateBehavior = undefined;
    run.loadAttempts = [];
    const result = await runProductionLaneComparison({
      run,
      runProductionScenario: vi.fn(),
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.steps[0]?.detail).toContain("passed Reference Lane generation attempt");
    expect(result.steps[0]?.detail).toContain("passed user-generation template case");
    expect(result.steps[0]?.detail).not.toContain("resolved repository revision");
  });
  it("records a passed Production Lane and exact token comparison", async () => {
    const onEvent = vi.fn();
    const runProductionScenario = vi.fn().mockResolvedValue(productionObservation);
    const result = await runProductionLaneComparison({
      run: structuredClone(baseRun),
      runProductionScenario,
      onEvent,
      now: () => "after",
    });
    expect(result.productionLane.status).toBe("passed");
    expect(runProductionScenario).toHaveBeenCalledWith({
      scenario: expect.objectContaining({
        toolResultContinuation: undefined,
        multimodalFixture: expect.objectContaining({
          fixtureId: "single-transparent-pixel-png-v1",
          mimeType: "image/png",
          byteLength: 68,
          maxNewTokens: 1,
        }),
      }),
    });
    expect(result.laneComparison).toMatchObject({ exactInputMatch: true });
    expect(result.steps[0]).toMatchObject({ status: "passed" });
    expect(onEvent).toHaveBeenLastCalledWith({ event: expect.objectContaining({ stepId: "lane-comparison", status: "passed" }) });
  });

  it("keeps Reference evidence and records a Production Lane error", async () => {
    const result = await runProductionLaneComparison({
      run: structuredClone(baseRun),
      runProductionScenario: vi.fn().mockRejectedValue(new Error("production failed")),
      onEvent: vi.fn(),
      now: () => "after",
    });
    expect(result.productionLane).toMatchObject({ status: "failed", error: { message: "production failed" } });
    expect(result.loadAttempts).toHaveLength(1);
    expect(result.laneComparison).toBeUndefined();
  });
  it("passes recognized Reference parser roundtrip evidence into Production continuation", async () => {
    const run = structuredClone(baseRun);
    run.loadAttempts[0]!.toolProtocolProbe = {
      status: "observed",
      forced: true,
      source: "chat-template-render",
      generationCaseId: "tools-generation",
      assistantToolCallCaseId: "assistant-tool-call-history",
      toolResultContinuationCaseId: "tool-result-continuation",
      inputTokenIds: [1],
      forcedTokenIds: [2],
      generatedTokenIds: [2],
      generatedText: "tool call",
      exactMatch: true,
      firstMismatchIndex: undefined,
      termination: "complete-forced-sequence",
      parserObservation: {
        status: "observed",
        strategy: "standard",
        parserKind: "standard-tool-call-stream-parser",
        inputMode: "production-text-streamer-reconstruction",
        inputChunks: ["tool call"],
        visibleText: "",
        callBoundaryCount: undefined,
        toolCalls: [{ name: "lookup_weather", arguments: '{"city":"Tokyo"}' }],
        recognized: true,
      },
      toolResultTemplateRoundTrip: {
        status: "observed",
        source: "recognized-production-parser-and-chat-template",
        parserStrategy: "standard",
        toolCall: { name: "lookup_weather", arguments: '{"city":"Tokyo"}' },
        toolResultContent: '{"temperatureC":20,"condition":"clear"}',
        selectedTemplate: "template",
        renderedText: "rendered",
        inputTokenIds: [50, 51, 52],
      },
    };
    const runProductionScenario = vi.fn().mockResolvedValue(productionObservation);

    await runProductionLaneComparison({
      run,
      runProductionScenario,
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(runProductionScenario).toHaveBeenCalledWith({
      scenario: expect.objectContaining({
        toolResultContinuation: {
          toolCall: { name: "lookup_weather", arguments: '{"city":"Tokyo"}' },
          toolResultContent: '{"temperatureC":20,"condition":"clear"}',
          expectedInputTokenIds: [50, 51, 52],
          maxNewTokens: 16,
        },
      }),
    });
  });

});
