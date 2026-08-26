import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationGenerationAutoClassName,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationInputTensorMetadata,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationLoadedModelObservation,
  ModelSupportInvestigationNaturalGenerationObservation,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationTemplateBehavior,
  ModelSupportInvestigationToolProtocolProbe,
} from "@/features/transformers-js/model-support-investigation/types";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
import { planToolProtocolProbe } from "@/features/transformers-js/model-support-investigation/logic/plan-tool-protocol-probe";

const MAXIMUM_FORCED_TOOL_PROTOCOL_TOKENS = 256;

function supportsGenericTextOnlyInput({ autoClass }: {
  autoClass: ModelSupportInvestigationGenerationAutoClassName,
}): boolean {
  return autoClass === "AutoModelForCausalLM" || autoClass === "AutoModelForSeq2SeqLM";
}

function detail({ candidate, stage }: {
  candidate: ModelSupportInvestigationCandidateFilePlan,
  stage: ModelSupportInvestigationLoadAttemptStage,
}): string {
  return `${candidate.candidateId}: ${stage}`;
}

export async function runCandidateLoadAttempt<TModel, TInput>({
  repository,
  declarations,
  templateBehavior,
  candidate,
  autoClass,
  loadModel,
  observeLoadedModel,
  buildInput,
  generateMinimumToken,
  generateNaturalBaseline,
  generateToolProtocolProbe,
  disposeInput,
  disposeModel,
  onAttemptEvent,
  now,
  createAttemptId,
}: {
  repository: ModelSupportInvestigationRepository,
  declarations: ModelSupportInvestigationModelDeclarations,
  templateBehavior: ModelSupportInvestigationTemplateBehavior | undefined,
  candidate: ModelSupportInvestigationCandidateFilePlan,
  autoClass: ModelSupportInvestigationGenerationAutoClassName | undefined,
  loadModel: () => Promise<TModel>,
  observeLoadedModel: ({ model }: { model: TModel }) => ModelSupportInvestigationLoadedModelObservation,
  buildInput: ({ inputIds }: { inputIds: number[] }) => Promise<{
    input: TInput,
    tensors: ModelSupportInvestigationInputTensorMetadata[],
  }>,
  generateMinimumToken: ({ model, input }: {
    model: TModel,
    input: TInput,
  }) => Promise<{ generatedTokenIds: number[], generatedText: string, modelType: string | undefined }>,
  generateNaturalBaseline: ({ model, input }: {
    model: TModel,
    input: TInput,
  }) => Promise<ModelSupportInvestigationNaturalGenerationObservation>,
  generateToolProtocolProbe: ({ model, inputTokenIds, forcedTokenIds }: {
    model: TModel,
    inputTokenIds: number[],
    forcedTokenIds: number[],
  }) => Promise<Extract<ModelSupportInvestigationToolProtocolProbe, { status: "observed" }>>,
  disposeInput: ({ input }: { input: TInput }) => Promise<void>,
  disposeModel: ({ model }: { model: TModel }) => Promise<void>,
  onAttemptEvent: ({ event }: { event: ModelSupportInvestigationLoadAttemptEvent }) => void,
  now: () => string,
  createAttemptId: () => string,
}): Promise<ModelSupportInvestigationLoadAttempt> {
  const startedAt = now();
  const events: ModelSupportInvestigationLoadAttemptEvent[] = [];
  let activeStage: ModelSupportInvestigationLoadAttemptStage = "worker-start";
  const emit = ({ stage, status, eventDetail = detail({ candidate, stage }) }: {
    stage: ModelSupportInvestigationLoadAttemptStage,
    status: ModelSupportInvestigationLoadAttemptEvent["status"],
    eventDetail?: string,
  }): void => {
    activeStage = stage;
    const event = { stage, status, detail: eventDetail, at: now() };
    events.push(event);
    onAttemptEvent({ event });
  };
  const base = {
    attemptId: createAttemptId(),
    candidateId: candidate.candidateId,
    device: candidate.device,
    dtype: candidate.dtype,
    autoClass,
    resolvedRevision: repository.resolvedRevision,
    startedAt,
  };

  emit({ stage: "worker-start", status: "passed" });
  switch (candidate.eligibility) {
  case "eligible":
    break;
  case "ineligible":
  case "registry-failed": {
    emit({
      stage: "auto-class-selection",
      status: "failed",
      eventDetail: `${candidate.candidateId}: candidate is ${candidate.eligibility}`,
    });
    return {
      ...base,
      completedAt: now(),
      status: "blocked",
      failureStage: "auto-class-selection",
      events,
      inputTokenCount: undefined,
      inputTokenIds: [],
      inputTensors: [],
      loadedModel: undefined,
      generatedTokenIds: [],
      generatedText: undefined,
      naturalGeneration: undefined,
      toolProtocolProbe: undefined,
      modelType: declarations.modelType,
      error: {
        name: "CandidateNotEligibleError",
        message: candidate.ineligibleReasons.join("; ") || `Candidate is ${candidate.eligibility}`,
        stack: undefined,
      },
    };
  }
  default: {
    const _ex: never = candidate.eligibility;
    return _ex;
  }
  }
  if (autoClass === undefined) {
    emit({ stage: "auto-class-selection", status: "failed" });
    return {
      ...base,
      completedAt: now(),
      status: "blocked",
      failureStage: "auto-class-selection",
      events,
      inputTokenCount: undefined,
      inputTokenIds: [],
      inputTensors: [],
      loadedModel: undefined,
      generatedTokenIds: [],
      generatedText: undefined,
      naturalGeneration: undefined,
      toolProtocolProbe: undefined,
      modelType: declarations.modelType,
      error: {
        name: "GenerativeAutoClassUnavailableError",
        message: "No supported public generative Auto class was observed",
        stack: undefined,
      },
    };
  }
  emit({ stage: "auto-class-selection", status: "passed", eventDetail: `${candidate.candidateId}: ${autoClass}` });

  let model: TModel | undefined;
  let input: TInput | undefined;
  const templateCase = templateBehavior?.cases.find(item => item.caseId === "user-generation" && item.status === "passed");
  const inputIds = templateCase?.inputIds ?? [];
  let loadedModel: ModelSupportInvestigationLoadedModelObservation | undefined;
  let inputTensors: ModelSupportInvestigationInputTensorMetadata[] = [];
  let result: { generatedTokenIds: number[], generatedText: string, modelType: string | undefined } | undefined;
  let naturalGeneration: ModelSupportInvestigationNaturalGenerationObservation | undefined;
  let toolProtocolProbe: ModelSupportInvestigationToolProtocolProbe | undefined;
  let failureStage: ModelSupportInvestigationLoadAttemptStage | undefined;
  let failure: ModelSupportInvestigationLoadAttempt["error"];
  try {
    emit({ stage: "model-load", status: "running" });
    model = await loadModel();
    loadedModel = observeLoadedModel({ model });
    emit({ stage: "model-load", status: "passed" });
    if (!supportsGenericTextOnlyInput({ autoClass })) {
      failureStage = "input-build";
      failure = {
        name: "ReferenceInputBuilderUnavailableError",
        message: `Generic Reference input construction for ${autoClass} requires modality/processor inputs; text-only tensors were not submitted`,
        stack: undefined,
      };
      emit({
        stage: "input-build",
        status: "failed",
        eventDetail: `${candidate.candidateId}: ${failure.message}`,
      });
    } else if (inputIds.length === 0) {
      failureStage = "input-build";
      failure = {
        name: "TemplateInputUnavailableError",
        message: "The deterministic user-generation template case did not produce input token IDs",
        stack: undefined,
      };
      emit({
        stage: "input-build",
        status: "failed",
        eventDetail: `${candidate.candidateId}: ${failure.message}`,
      });
    } else {
      emit({ stage: "input-build", status: "running" });
      const builtInput = await buildInput({ inputIds });
      input = builtInput.input;
      inputTensors = builtInput.tensors;
      emit({ stage: "input-build", status: "passed", eventDetail: `${candidate.candidateId}: ${inputIds.length} input tokens` });
      emit({ stage: "first-generation", status: "running" });
      result = await generateMinimumToken({ model, input });
      if (result.generatedTokenIds.length < 1) {
        throw new Error("Minimum generation returned no new token IDs");
      }
      emit({
        stage: "first-generation",
        status: "passed",
        eventDetail: `${candidate.candidateId}: generated ${result.generatedTokenIds.length} token`,
      });
      emit({ stage: "natural-generation", status: "running" });
      naturalGeneration = await generateNaturalBaseline({ model, input });
      emit({
        stage: "natural-generation",
        status: "passed",
        eventDetail: `${candidate.candidateId}: observed ${naturalGeneration.generatedTokenIds.length} natural tokens`,
      });
      const toolProbePlan = planToolProtocolProbe({
        provenance: templateBehavior?.toolTemplateProvenance,
        isEncoderDecoder: loadedModel.isEncoderDecoder,
        maximumForcedTokenCount: MAXIMUM_FORCED_TOOL_PROTOCOL_TOKENS,
      });
      switch (toolProbePlan.status) {
      case "unavailable":
        toolProtocolProbe = {
          status: "unavailable",
          forced: false,
          source: "chat-template-render",
          generationCaseId: "tools-generation",
          assistantToolCallCaseId: "assistant-tool-call-history",
          toolResultContinuationCaseId: "tool-result-continuation",
          reason: toolProbePlan.reason,
        };
        emit({
          stage: "tool-protocol-probe",
          status: "skipped",
          eventDetail: `${candidate.candidateId}: tool protocol probe unavailable: ${toolProbePlan.reason}`,
        });
        break;
      case "eligible":
        emit({ stage: "tool-protocol-probe", status: "running" });
        try {
          toolProtocolProbe = await generateToolProtocolProbe({
            model,
            inputTokenIds: toolProbePlan.inputTokenIds,
            forcedTokenIds: toolProbePlan.forcedTokenIds,
          });
          emit({
            stage: "tool-protocol-probe",
            status: "passed",
            eventDetail: toolProtocolProbe.exactMatch
              ? `${candidate.candidateId}: forced ${toolProtocolProbe.generatedTokenIds.length} template-derived tool protocol tokens`
              : `${candidate.candidateId}: tool protocol generation first differed at index ${toolProtocolProbe.firstMismatchIndex ?? 0}`,
          });
        } catch (error) {
          const serialized = serializeInvestigationError({ error });
          toolProtocolProbe = {
            status: "failed",
            forced: true,
            source: "chat-template-render",
            generationCaseId: "tools-generation",
            assistantToolCallCaseId: "assistant-tool-call-history",
            toolResultContinuationCaseId: "tool-result-continuation",
            inputTokenIds: toolProbePlan.inputTokenIds,
            forcedTokenIds: toolProbePlan.forcedTokenIds,
            error: serialized,
          };
          emit({
            stage: "tool-protocol-probe",
            status: "failed",
            eventDetail: `${candidate.candidateId}: tool protocol probe failed: ${serialized.message}`,
          });
        }
        break;
      default: {
        const _ex: never = toolProbePlan;
        return _ex;
      }
      }
    }
  } catch (error) {
    failureStage = activeStage;
    failure = serializeInvestigationError({ error });
    emit({ stage: activeStage, status: "failed", eventDetail: `${candidate.candidateId}: ${failure.message}` });
  } finally {
    if (input !== undefined || model !== undefined) {
      emit({ stage: "dispose", status: "running" });
      let disposeFailure: NonNullable<ModelSupportInvestigationLoadAttempt["error"]> | undefined;
      if (input !== undefined) {
        try {
          await disposeInput({ input });
        } catch (error) {
          disposeFailure = serializeInvestigationError({ error });
        }
      }
      if (model !== undefined) {
        try {
          await disposeModel({ model });
        } catch (error) {
          disposeFailure ??= serializeInvestigationError({ error });
        }
      }
      if (disposeFailure === undefined) {
        emit({ stage: "dispose", status: "passed" });
      } else {
        emit({ stage: "dispose", status: "failed", eventDetail: `${candidate.candidateId}: ${disposeFailure.message}` });
        if (failure === undefined) {
          failureStage = "dispose";
          failure = disposeFailure;
        }
      }
    }
  }

  return {
    ...base,
    completedAt: now(),
    status: failure === undefined ? "passed" : "failed",
    failureStage,
    events,
    inputTokenCount: inputIds.length,
    inputTokenIds: [...inputIds],
    inputTensors,
    loadedModel,
    generatedTokenIds: result?.generatedTokenIds ?? [],
    generatedText: result?.generatedText,
    naturalGeneration,
    toolProtocolProbe,
    modelType: result?.modelType ?? declarations.modelType,
    error: failure,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
