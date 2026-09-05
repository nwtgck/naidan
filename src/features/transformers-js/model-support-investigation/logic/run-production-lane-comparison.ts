import type {
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationPartialObservation,
  TransformersJsProductionInvestigationScenario,
} from "@/features/transformers-js/types";
import type {
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
} from "@/features/transformers-js/model-support-investigation/types";
import { compareInvestigationLanes } from "@/features/transformers-js/model-support-investigation/logic/compare-investigation-lanes";
import { investigationModelLoadRevision } from "@/features/transformers-js/model-support-investigation/logic/investigation-model-load-revision";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE } from "@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image";
import { isModelSupportInvestigationUserInterruptedError } from "@/features/transformers-js/model-support-investigation/logic/investigation-interruption";

function updateLaneStep({ run, status, detail }: {
  run: ModelSupportInvestigationRun,
  status: ModelSupportInvestigationStep["status"],
  detail: string,
}): void {
  run.steps = run.steps.map((step) => {
    switch (step.id) {
    case "lane-comparison":
      return { ...step, status, detail };
    case "runtime-assets":
    case "repository-information":
    case "download-evidence":
    case "existing-model-data":
    case "model-declarations":
    case "template-behavior":
    case "model-file-plan":
    case "loading-investigation":
    case "evidence-export":
      return step;
    default: {
      const _ex: never = step.id;
      return _ex;
    }
    }
  });
}

export async function runProductionLaneComparison({
  run,
  runProductionScenario,
  onEvent,
  onRunUpdate,
  now,
}: {
  run: ModelSupportInvestigationRun,
  runProductionScenario: ({ scenario, onObservationCheckpoint }: {
    scenario: TransformersJsProductionInvestigationScenario,
    onObservationCheckpoint: ({ observation }: { observation: TransformersJsProductionInvestigationPartialObservation }) => void,
  }) => Promise<TransformersJsProductionInvestigationObservation>,
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
  onRunUpdate?: ({ run }: { run: ModelSupportInvestigationRun }) => void,
  now: () => string,
}): Promise<ModelSupportInvestigationRun> {
  const updatedRun: ModelSupportInvestigationRun = {
    ...run,
    scope: "partial-runtime-repository-cache-declarations-template-model-files-load-lanes",
  };
  const emit = ({ status, detail }: {
    status: ModelSupportInvestigationStep["status"],
    detail: string,
  }): void => {
    updateLaneStep({ run: updatedRun, status, detail });
    onEvent({ event: { stepId: "lane-comparison", status, detail } });
  };

  const referenceAttempt = updatedRun.loadAttempts.find(attempt => attempt.status === "passed");
  const loadedAttempt = referenceAttempt
    ?? updatedRun.loadAttempts.find(attempt => attempt.loadedModel !== undefined);
  const eligibleCandidates = updatedRun.modelFilePlan?.candidates.filter(candidate => candidate.eligibility === "eligible") ?? [];
  const observedCandidate = loadedAttempt === undefined
    ? undefined
    : { device: loadedAttempt.device, dtype: loadedAttempt.dtype };
  const runtimeCompletion = updatedRun.downloadEvidence?.runtimeCompletion;
  const productionCandidates = (() => {
    if (runtimeCompletion !== undefined) {
      switch (runtimeCompletion.status) {
      case 'accepted': {
        if (observedCandidate !== undefined) return [observedCandidate] as const;
        const selected = runtimeCompletion.selectedCandidate;
        return selected === undefined ? undefined : [selected] as const;
      }
      case 'failed':
      case 'exhausted':
        return undefined;
      default: {
        const _ex: never = runtimeCompletion.status;
        throw new Error(`Unhandled runtime completion status: ${_ex}`);
      }
      }
    }
    const orderedCandidates = observedCandidate === undefined
      ? eligibleCandidates.map(candidate => ({ device: candidate.device, dtype: candidate.dtype }))
      : [
        observedCandidate,
        ...eligibleCandidates
          .filter(candidate => candidate.device !== observedCandidate.device || candidate.dtype !== observedCandidate.dtype)
          .map(candidate => ({ device: candidate.device, dtype: candidate.dtype })),
      ];
    const firstCandidate = orderedCandidates[0];
    return firstCandidate === undefined
      ? undefined
      : [firstCandidate, ...orderedCandidates.slice(1)] as const;
  })();
  const templateCase = updatedRun.templateBehavior?.cases.find(item => item.caseId === "user-generation");
  const repository = updatedRun.repository;
  if (productionCandidates === undefined || repository === undefined) {
    const missingPrerequisites = [
      productionCandidates === undefined ? "eligible Production Lane candidate" : undefined,
      repository === undefined ? "resolved repository revision" : undefined,
    ].filter((item): item is string => item !== undefined);
    const detail = `Blocked because these prerequisites are unavailable: ${missingPrerequisites.join(", ")}`;
    emit({ status: "blocked", detail });
    updatedRun.productionLane = { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined };
    updatedRun.currentOperation = `Production Lane comparison was blocked: ${missingPrerequisites.join(", ")}`;
    updatedRun.completedAt = now();
    return updatedRun;
  }

  const toolResultContinuation = (() => {
    const probe = referenceAttempt?.toolProtocolProbe;
    if (probe === undefined) return undefined;
    switch (probe.status) {
    case "failed":
    case "unavailable":
      return undefined;
    case "observed": {
      const roundTrip = probe.toolResultTemplateRoundTrip;
      if (roundTrip === undefined) return undefined;
      switch (roundTrip.status) {
      case "failed":
      case "unavailable":
        return undefined;
      case "observed":
        return {
          toolCall: roundTrip.toolCall,
          toolResultContent: roundTrip.toolResultContent,
          expectedInputTokenIds: roundTrip.inputTokenIds,
          maxNewTokens: 16 as const,
        };
      default: {
        const _ex: never = roundTrip;
        return _ex;
      }
      }
    }
    default: {
      const _ex: never = probe;
      return _ex;
    }
    }
  })();

  emit({
    status: "running",
    detail: `Starting Naidan Production Lane with ${productionCandidates.map(candidate => `${candidate.device}/${candidate.dtype}`).join(' -> ')} fallback order using a fresh Production Worker for each load candidate`,
  });
  try {
    const observation = await runProductionScenario({
      scenario: {
        modelId: repository.normalizedModelId,
        resolvedRevision: repository.resolvedRevision,
        loadRevision: runtimeCompletion === undefined
          ? investigationModelLoadRevision({ requestedRevision: repository.requestedRevision })
          : runtimeCompletion.loaderRevisionOption ?? undefined,
        candidates: [...productionCandidates],
        messages: (templateCase?.messages ?? [{ role: "user" as const, content: "Template probe user message." }]).map(message => ({
          role: message.role,
          content: message.content,
        })),
        followUpMessage: {
          role: "user",
          content: "Continue with one short sentence.",
        },
        toolResultContinuation,
        multimodalFixture: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE,
        maxNewTokens: 16,
      },
      onObservationCheckpoint: ({ observation }) => {
        updatedRun.productionLane = {
          status: "running",
          observation: undefined,
          partialObservation: structuredClone(observation),
          error: undefined,
        };
        updatedRun.currentOperation = "Production Lane is running; completed probe evidence is checkpointed";
        onRunUpdate?.({ run: structuredClone(updatedRun) });
      },
    });
    updatedRun.productionLane = { status: "passed", observation, partialObservation: undefined, error: undefined };
    const productionFirstTurnPassed = (() => {
      switch (observation.firstTurn.status) {
      case "passed":
        updatedRun.laneComparison = referenceAttempt === undefined
          || referenceAttempt.selectedInputStrategy === "fixed-plain-text-tokenizer-tensor-dict"
          ? undefined
          : compareInvestigationLanes({
            referenceAttempt,
            productionTurn: observation.firstTurn.turn,
            productionRoute: observation.route,
          });
        return true;
      case "failed":
        updatedRun.laneComparison = undefined;
        return false;
      default: {
        const _ex: never = observation.firstTurn;
        return _ex;
      }
      }
    })();
    const mismatch = updatedRun.laneComparison?.firstInputMismatchIndex;
    emit({
      status: "passed",
      detail: !productionFirstTurnPassed
        ? `Production Lane used ${observation.route.strategy}; first-turn generation failed, but independent Production probes continued`
        : updatedRun.laneComparison === undefined
          ? `Production Lane used ${observation.route.strategy}; Production evidence was collected without a passed Reference generation comparison`
          : mismatch === undefined
            ? `Production Lane used ${observation.route.strategy}; input token IDs exactly matched the Reference Lane`
            : `Production Lane used ${observation.route.strategy}; first input token mismatch was at index ${mismatch}`,
    });
    updatedRun.currentOperation = !productionFirstTurnPassed
      ? "Production Lane collected partial evidence after first-turn failure"
      : updatedRun.laneComparison === undefined
        ? "Production Lane evidence collected; Reference comparison unavailable"
        : "Reference and Production Lane evidence collected";
  } catch (error) {
    if (isModelSupportInvestigationUserInterruptedError({ error })) throw error;
    const serialized = serializeInvestigationError({ error });
    updatedRun.productionLane = {
      status: "failed",
      observation: undefined,
      partialObservation: updatedRun.productionLane.partialObservation,
      error: serialized,
    };
    updatedRun.laneComparison = undefined;
    updatedRun.status = "failed";
    updatedRun.error = updatedRun.error === undefined
      ? `Production Lane failed: ${serialized.message}`
      : `${updatedRun.error}; Production Lane failed: ${serialized.message}`;
    emit({ status: "failed", detail: `Production Lane failed: ${serialized.message}` });
    updatedRun.currentOperation = "Production Lane failed after Reference Lane evidence was collected";
  }
  updatedRun.completedAt = now();
  return updatedRun;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
