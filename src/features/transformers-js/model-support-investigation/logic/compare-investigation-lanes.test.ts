import { describe, expect, it } from "vitest";
import { compareInvestigationLanes } from "@/features/transformers-js/model-support-investigation/logic/compare-investigation-lanes";
import type { ModelSupportInvestigationLoadAttempt } from "@/features/transformers-js/model-support-investigation/types";
import type {
  TransformersJsProductionInvestigationObservation,
  TransformersJsProductionInvestigationTurnObservation,
} from "@/features/transformers-js/types";

const referenceAttempt = {
  attemptId: "attempt-1",
  inputTokenIds: [1, 2, 3],
  generatedTokenIds: [4],
} as ModelSupportInvestigationLoadAttempt;

const productionTurn = {
  inputTokenIds: [1, 2, 3],
  generatedTokenIds: [5],
} as TransformersJsProductionInvestigationTurnObservation;

const productionRoute = {
  autoClass: "AutoModelForCausalLM",
  processor: "tokenizer",
  strategy: "standard",
  modelType: "example",
} as TransformersJsProductionInvestigationObservation["route"];

describe("compareInvestigationLanes", () => {
  it("reports exact input identity", () => {
    expect(compareInvestigationLanes({ referenceAttempt, productionTurn, productionRoute })).toMatchObject({
      exactInputMatch: true,
      firstInputMismatchIndex: undefined,
      referenceGeneratedTokenIds: [4],
      productionGeneratedTokenIds: [5],
    });
  });

  it("reports the first token mismatch", () => {
    expect(compareInvestigationLanes({
      referenceAttempt,
      productionTurn: { ...productionTurn, inputTokenIds: [1, 9, 3] },
      productionRoute,
    })).toMatchObject({
      exactInputMatch: false,
      firstInputMismatchIndex: 1,
    });
  });

  it("reports the shared length when one token sequence is a strict prefix", () => {
    expect(compareInvestigationLanes({
      referenceAttempt,
      productionTurn: { ...productionTurn, inputTokenIds: [1, 2] },
      productionRoute,
    })).toMatchObject({
      exactInputMatch: false,
      firstInputMismatchIndex: 2,
    });
  });
});
