import { describe, expect, it } from "vitest";
import { compareInvestigationLanes } from "@/features/transformers-js/model-support-investigation/logic/compare-investigation-lanes";
import type { ModelSupportInvestigationLoadAttempt } from "@/features/transformers-js/model-support-investigation/types";
import type { TransformersJsProductionInvestigationObservation } from "@/features/transformers-js/types";

const referenceAttempt = {
  attemptId: "attempt-1",
  inputTokenIds: [1, 2, 3],
  generatedTokenIds: [4],
} as ModelSupportInvestigationLoadAttempt;

const productionObservation = {
  inputTokenIds: [1, 2, 3],
  generatedTokenIds: [5],
  route: {
    autoClass: "AutoModelForCausalLM",
    processor: "tokenizer",
    strategy: "standard",
    modelType: "example",
  },
} as TransformersJsProductionInvestigationObservation;

describe("compareInvestigationLanes", () => {
  it("reports exact input identity", () => {
    expect(compareInvestigationLanes({ referenceAttempt, productionObservation })).toMatchObject({
      exactInputMatch: true,
      firstInputMismatchIndex: undefined,
      referenceGeneratedTokenIds: [4],
      productionGeneratedTokenIds: [5],
    });
  });

  it("reports the first token mismatch", () => {
    expect(compareInvestigationLanes({
      referenceAttempt,
      productionObservation: { ...productionObservation, inputTokenIds: [1, 9, 3] },
    })).toMatchObject({
      exactInputMatch: false,
      firstInputMismatchIndex: 1,
    });
  });

  it("reports the shared length when one token sequence is a strict prefix", () => {
    expect(compareInvestigationLanes({
      referenceAttempt,
      productionObservation: { ...productionObservation, inputTokenIds: [1, 2] },
    })).toMatchObject({
      exactInputMatch: false,
      firstInputMismatchIndex: 2,
    });
  });
});
