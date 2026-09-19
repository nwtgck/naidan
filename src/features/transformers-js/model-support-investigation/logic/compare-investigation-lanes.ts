import type {
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationTurnObservation,
} from "@/features/transformers-js/types";
import type {
  ModelSupportInvestigationLaneComparison,
  ModelSupportInvestigationLoadAttempt,
} from "@/features/transformers-js/model-support-investigation/types";

function firstMismatchIndex({ left, right }: {
  left: number[],
  right: number[],
}): number | undefined {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? undefined : commonLength;
}

export function compareInvestigationLanes({ referenceAttempt, productionTurn, productionRoute }: {
  referenceAttempt: ModelSupportInvestigationLoadAttempt,
  productionTurn: TransformersJsProductionInvestigationTurnObservation,
  productionRoute: TransformersJsProductionInvestigationObservation["route"],
}): ModelSupportInvestigationLaneComparison {
  const mismatchIndex = firstMismatchIndex({
    left: referenceAttempt.inputTokenIds,
    right: productionTurn.inputTokenIds,
  });
  return {
    scenarioCaseId: "user-generation",
    referenceAttemptId: referenceAttempt.attemptId,
    exactInputMatch: mismatchIndex === undefined,
    firstInputMismatchIndex: mismatchIndex,
    referenceInputTokenIds: [...referenceAttempt.inputTokenIds],
    productionInputTokenIds: [...productionTurn.inputTokenIds],
    referenceGeneratedTokenIds: [...referenceAttempt.generatedTokenIds],
    productionGeneratedTokenIds: [...productionTurn.generatedTokenIds],
    productionRoute: { ...productionRoute },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
