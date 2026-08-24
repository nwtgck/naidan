import type { TransformersJsProductionInvestigationObservation } from "@/features/transformers-js/types";
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

export function compareInvestigationLanes({ referenceAttempt, productionObservation }: {
  referenceAttempt: ModelSupportInvestigationLoadAttempt,
  productionObservation: TransformersJsProductionInvestigationObservation,
}): ModelSupportInvestigationLaneComparison {
  const mismatchIndex = firstMismatchIndex({
    left: referenceAttempt.inputTokenIds,
    right: productionObservation.inputTokenIds,
  });
  return {
    scenarioCaseId: "user-generation",
    referenceAttemptId: referenceAttempt.attemptId,
    exactInputMatch: mismatchIndex === undefined,
    firstInputMismatchIndex: mismatchIndex,
    referenceInputTokenIds: [...referenceAttempt.inputTokenIds],
    productionInputTokenIds: [...productionObservation.inputTokenIds],
    referenceGeneratedTokenIds: [...referenceAttempt.generatedTokenIds],
    productionGeneratedTokenIds: [...productionObservation.generatedTokenIds],
    productionRoute: { ...productionObservation.route },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
