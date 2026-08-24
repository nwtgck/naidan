import type {
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationScenario,
} from "@/features/transformers-js/types";
import type {
  ModelSupportInvestigationEvent,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationStep,
} from "@/features/transformers-js/model-support-investigation/types";
import { compareInvestigationLanes } from "@/features/transformers-js/model-support-investigation/logic/compare-investigation-lanes";
import { serializeInvestigationError } from "@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error";
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE } from "@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image";
import { createCacheRevisionAliases } from "@/features/transformers-js/model-support-investigation/logic/create-cache-revision-aliases";

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
  now,
}: {
  run: ModelSupportInvestigationRun,
  runProductionScenario: ({ scenario }: {
    scenario: TransformersJsProductionInvestigationScenario,
  }) => Promise<TransformersJsProductionInvestigationObservation>,
  onEvent: ({ event }: { event: ModelSupportInvestigationEvent }) => void,
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
  const templateCase = updatedRun.templateBehavior?.cases.find(item => (
    item.caseId === "user-generation" && item.status === "passed"
  ));
  const repository = updatedRun.repository;
  if (referenceAttempt === undefined || templateCase === undefined || repository === undefined) {
    const missingPrerequisites = [
      referenceAttempt === undefined ? "passed Reference Lane generation attempt" : undefined,
      templateCase === undefined ? "passed user-generation template case" : undefined,
      repository === undefined ? "resolved repository revision" : undefined,
    ].filter((item): item is string => item !== undefined);
    const detail = `Blocked because these prerequisites are unavailable: ${missingPrerequisites.join(", ")}`;
    emit({ status: "blocked", detail });
    updatedRun.productionLane = { status: "not-run", observation: undefined, error: undefined };
    updatedRun.currentOperation = `Production Lane comparison was blocked: ${missingPrerequisites.join(", ")}`;
    updatedRun.completedAt = now();
    return updatedRun;
  }

  const toolResultContinuation = (() => {
    const probe = referenceAttempt.toolProtocolProbe;
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
    detail: `Starting Naidan Production Lane with ${referenceAttempt.candidateId} in a fresh production Worker`,
  });
  try {
    const observation = await runProductionScenario({
      scenario: {
        modelId: repository.normalizedModelId,
        resolvedRevision: repository.resolvedRevision,
        cacheRevisionAliases: createCacheRevisionAliases({
          repository,
          provenance: updatedRun.cache?.provenance,
        }),
        candidate: {
          device: referenceAttempt.device,
          dtype: referenceAttempt.dtype,
        },
        messages: templateCase.messages.map(message => ({
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
    });
    updatedRun.productionLane = { status: "passed", observation, error: undefined };
    updatedRun.laneComparison = compareInvestigationLanes({
      referenceAttempt,
      productionObservation: observation,
    });
    const mismatch = updatedRun.laneComparison.firstInputMismatchIndex;
    emit({
      status: "passed",
      detail: mismatch === undefined
        ? `Production Lane used ${observation.route.strategy}; input token IDs exactly matched the Reference Lane`
        : `Production Lane used ${observation.route.strategy}; first input token mismatch was at index ${mismatch}`,
    });
    updatedRun.currentOperation = "Reference and Production Lane evidence collected";
  } catch (error) {
    const serialized = serializeInvestigationError({ error });
    updatedRun.productionLane = { status: "failed", observation: undefined, error: serialized };
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
