import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationGenerationAutoClassName,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationLoadAttemptCheckpoint,
  ModelSupportInvestigationInputTensorMetadata,
  ModelSupportInvestigationInputStrategyAttempt,
  ModelSupportInvestigationLoadAttemptEvent,
  ModelSupportInvestigationLoadAttemptStage,
  ModelSupportInvestigationLoadedModelObservation,
  ModelSupportInvestigationNaturalGenerationObservation,
  ModelSupportInvestigationModelDeclarations,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationTemplateBehavior,
  ModelSupportInvestigationTextInputStrategy,
  ModelSupportInvestigationToolProtocolProbe,
} from "@/features/transformers-js/model-support-investigation/types";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
import { planToolProtocolProbe } from "@/features/transformers-js/model-support-investigation/logic/plan-tool-protocol-probe";
import { MODEL_SUPPORT_INVESTIGATION_REFERENCE_PLAIN_TEXT } from "@/features/transformers-js/model-support-investigation/fixtures/reference-plain-text";

const MAXIMUM_FORCED_TOOL_PROTOCOL_TOKENS = 256;
const TEXT_INPUT_STRATEGIES: ModelSupportInvestigationTextInputStrategy[] = [
  "chat-template-tensor-dict",
  "observed-token-ids-transformers-tensor",
  "fixed-plain-text-tokenizer-tensor-dict",
];


function inputTextFieldsForStrategy({ strategy }: {
  strategy: ModelSupportInvestigationTextInputStrategy,
}): { inputText?: string } {
  switch (strategy) {
  case "chat-template-tensor-dict":
  case "observed-token-ids-transformers-tensor":
    return {};
  case "fixed-plain-text-tokenizer-tensor-dict":
    return { inputText: MODEL_SUPPORT_INVESTIGATION_REFERENCE_PLAIN_TEXT };
  default: {
    const _ex: never = strategy;
    throw new Error(`Unhandled Reference input strategy: ${_ex}`);
  }
  }
}

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
  onAttemptUpdate = () => undefined,
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
  buildInput: ({ inputIds, strategy }: {
    inputIds: number[],
    strategy: ModelSupportInvestigationTextInputStrategy,
  }) => Promise<{
    input: TInput,
    inputTokenIds: number[],
    tensors: ModelSupportInvestigationInputTensorMetadata[],
    inputText?: string,
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
    inputStrategy: ModelSupportInvestigationTextInputStrategy,
  }) => Promise<Extract<ModelSupportInvestigationToolProtocolProbe, { status: "observed" }>>,
  disposeInput: ({ input }: { input: TInput }) => Promise<void>,
  disposeModel: ({ model }: { model: TModel }) => Promise<void>,
  onAttemptEvent: ({ event }: { event: ModelSupportInvestigationLoadAttemptEvent }) => void,
  onAttemptUpdate?: ({ attempt }: { attempt: ModelSupportInvestigationLoadAttemptCheckpoint }) => void,
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
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
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
      inputStrategyAttempts: [],
      selectedInputStrategy: undefined,
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
  const observedInputIds = templateCase?.inputIds ?? [];
  let selectedInputIds: number[] = [];
  let selectedInputStrategy: ModelSupportInvestigationTextInputStrategy | undefined;
  const inputStrategyAttempts: ModelSupportInvestigationInputStrategyAttempt[] = [];
  let loadedModel: ModelSupportInvestigationLoadedModelObservation | undefined;
  let inputTensors: ModelSupportInvestigationInputTensorMetadata[] = [];
  let result: { generatedTokenIds: number[], generatedText: string, modelType: string | undefined } | undefined;
  let naturalGeneration: ModelSupportInvestigationNaturalGenerationObservation | undefined;
  let toolProtocolProbe: ModelSupportInvestigationToolProtocolProbe | undefined;
  let failureStage: ModelSupportInvestigationLoadAttemptStage | undefined;
  let failure: ModelSupportInvestigationLoadAttempt["error"];
  let activeInputStrategy: ModelSupportInvestigationTextInputStrategy | undefined;
  let activeInputText: string | undefined;
  let activeInputIds: number[] = [];
  let activeInputTensors: ModelSupportInvestigationInputTensorMetadata[] = [];
  const publishAttemptCheckpoint = (): void => {
    const checkpoint: ModelSupportInvestigationLoadAttemptCheckpoint = {
      ...base,
      checkpointedAt: now(),
      status: "running",
      currentStage: activeStage,
      events: events.map(event => ({ ...event })),
      inputStrategyAttempts: inputStrategyAttempts.map(attempt => structuredClone(attempt)),
      activeInputStrategy,
      activeInputText,
      selectedInputStrategy,
      inputTokenCount: selectedInputStrategy === undefined
        ? (activeInputStrategy === undefined ? undefined : activeInputIds.length)
        : selectedInputIds.length,
      inputTokenIds: [...(selectedInputStrategy === undefined ? activeInputIds : selectedInputIds)],
      inputTensors: (selectedInputStrategy === undefined ? activeInputTensors : inputTensors).map(tensor => ({
        ...tensor,
        dims: [...tensor.dims],
      })),
      loadedModel: loadedModel === undefined ? undefined : structuredClone(loadedModel),
      generatedTokenIds: [...(result?.generatedTokenIds ?? [])],
      generatedText: result?.generatedText,
      naturalGeneration: naturalGeneration === undefined ? undefined : structuredClone(naturalGeneration),
      toolProtocolProbe: toolProtocolProbe === undefined ? undefined : structuredClone(toolProtocolProbe),
      modelType: result?.modelType ?? declarations.modelType,
      error: failure === undefined ? undefined : structuredClone(failure),
    };
    onAttemptUpdate({ attempt: checkpoint });
  };
  try {
    emit({ stage: "model-load", status: "running" });
    model = await loadModel();
    loadedModel = observeLoadedModel({ model });
    emit({ stage: "model-load", status: "passed" });
    publishAttemptCheckpoint();
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
    } else {
      for (const strategy of TEXT_INPUT_STRATEGIES) {
        let strategyInput: TInput | undefined;
        activeInputStrategy = strategy;
        activeInputText = undefined;
        activeInputIds = [];
        activeInputTensors = [];
        let strategyInputIds: number[] = [];
        let strategyTensors: ModelSupportInvestigationInputTensorMetadata[] = [];
        let strategyInputText: string | undefined;
        emit({
          stage: "input-build",
          status: "running",
          eventDetail: `${candidate.candidateId}: input strategy ${strategy}`,
        });
        try {
          const builtInput = await buildInput({ inputIds: observedInputIds, strategy });
          strategyInput = builtInput.input;
          strategyInputIds = builtInput.inputTokenIds;
          strategyTensors = builtInput.tensors;
          strategyInputText = builtInput.inputText;
          activeInputText = strategyInputText;
          activeInputIds = [...strategyInputIds];
          activeInputTensors = strategyTensors.map(tensor => ({ ...tensor, dims: [...tensor.dims] }));
          emit({
            stage: "input-build",
            status: "passed",
            eventDetail: `${candidate.candidateId}: ${strategy} produced ${strategyInputIds.length} input tokens`,
          });
          publishAttemptCheckpoint();
        } catch (error) {
          const serialized = serializeInvestigationError({ error });
          inputStrategyAttempts.push({
            strategy,
            status: "failed",
            failureStage: "input-build",
            inputTokenIds: [],
            inputTensors: [],
            ...inputTextFieldsForStrategy({ strategy }),
            error: serialized,
          });
          emit({
            stage: "input-build",
            status: "failed",
            eventDetail: `${candidate.candidateId}: ${strategy} failed to build input: ${serialized.message}`,
          });
          activeInputStrategy = undefined;
          activeInputText = undefined;
          activeInputIds = [];
          activeInputTensors = [];
          publishAttemptCheckpoint();
          continue;
        }

        emit({
          stage: "first-generation",
          status: "running",
          eventDetail: `${candidate.candidateId}: trying ${strategy}`,
        });
        try {
          const strategyResult = await generateMinimumToken({ model, input: strategyInput });
          if (strategyResult.generatedTokenIds.length < 1) {
            throw new Error("Minimum generation returned no new token IDs");
          }
          result = strategyResult;
          input = strategyInput;
          selectedInputIds = strategyInputIds;
          inputTensors = strategyTensors;
          selectedInputStrategy = strategy;
          inputStrategyAttempts.push({
            strategy,
            status: "passed",
            failureStage: undefined,
            inputTokenIds: [...strategyInputIds],
            inputTensors: strategyTensors,
            ...(strategyInputText === undefined ? {} : { inputText: strategyInputText }),
            error: undefined,
          });
          emit({
            stage: "first-generation",
            status: "passed",
            eventDetail: `${candidate.candidateId}: ${strategy} generated ${strategyResult.generatedTokenIds.length} token`,
          });
          activeInputStrategy = undefined;
          activeInputText = undefined;
          activeInputIds = [];
          activeInputTensors = [];
          publishAttemptCheckpoint();
          break;
        } catch (error) {
          const serialized = serializeInvestigationError({ error });
          inputStrategyAttempts.push({
            strategy,
            status: "failed",
            failureStage: "first-generation",
            inputTokenIds: [...strategyInputIds],
            inputTensors: strategyTensors,
            ...(strategyInputText === undefined ? {} : { inputText: strategyInputText }),
            error: serialized,
          });
          emit({
            stage: "first-generation",
            status: "failed",
            eventDetail: `${candidate.candidateId}: ${strategy} generation failed: ${serialized.message}`,
          });
          publishAttemptCheckpoint();
          try {
            await disposeInput({ input: strategyInput });
          } catch (disposeError) {
            input = strategyInput;
            failureStage = "dispose";
            failure = serializeInvestigationError({ error: disposeError });
            emit({
              stage: "dispose",
              status: "failed",
              eventDetail: `${candidate.candidateId}: ${strategy} cleanup failed after generation failure: ${failure.message}; aborting input-strategy fallback`,
            });
            publishAttemptCheckpoint();
            break;
          }
          activeInputStrategy = undefined;
          activeInputText = undefined;
          activeInputIds = [];
          activeInputTensors = [];
          publishAttemptCheckpoint();
        }
      }
      if (result === undefined || input === undefined || selectedInputStrategy === undefined) {
        if (failure === undefined) {
          failureStage = inputStrategyAttempts.some(attempt => attempt.failureStage === "first-generation")
            ? "first-generation"
            : "input-build";
          failure = {
            name: "ReferenceInputStrategiesExhaustedError",
            message: `All ${inputStrategyAttempts.length} deterministic text input strategies failed`,
            stack: undefined,
          };
        }
      } else {
        emit({ stage: "natural-generation", status: "running" });
        try {
          naturalGeneration = await generateNaturalBaseline({ model, input });
          switch (naturalGeneration.status) {
          case "observed":
            emit({
              stage: "natural-generation",
              status: "passed",
              eventDetail: `${candidate.candidateId}: observed ${naturalGeneration.generatedTokenIds.length} natural tokens`,
            });
            break;
          case "failed":
            emit({
              stage: "natural-generation",
              status: "failed",
              eventDetail: `${candidate.candidateId}: natural baseline failed: ${naturalGeneration.error.message}; continuing independent probes`,
            });
            break;
          default: {
            const _ex: never = naturalGeneration;
            return _ex;
          }
          }
        } catch (error) {
          const serialized = serializeInvestigationError({ error });
          naturalGeneration = {
            status: "failed",
            forced: false,
            maxNewTokens: 16,
            doSample: false,
            error: serialized,
          };
          emit({
            stage: "natural-generation",
            status: "failed",
            eventDetail: `${candidate.candidateId}: natural baseline failed: ${serialized.message}; continuing independent probes`,
          });
        }
        publishAttemptCheckpoint();
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
              inputStrategy: selectedInputStrategy,
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
        publishAttemptCheckpoint();
      }
    }
  } catch (error) {
    failureStage = activeStage;
    failure = serializeInvestigationError({ error });
    emit({ stage: activeStage, status: "failed", eventDetail: `${candidate.candidateId}: ${failure.message}` });
    publishAttemptCheckpoint();
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
      publishAttemptCheckpoint();
    }
  }

  return {
    ...base,
    completedAt: now(),
    status: failure === undefined ? "passed" : "failed",
    failureStage,
    events,
    inputStrategyAttempts,
    selectedInputStrategy,
    inputTokenCount: selectedInputStrategy === undefined ? undefined : selectedInputIds.length,
    inputTokenIds: [...selectedInputIds],
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
