import type { TransformersJsProductionInvestigationContinuityObservation } from "@/features/transformers-js/types";

type PrefixComparison = Extract<
  TransformersJsProductionInvestigationContinuityObservation,
  { status: "passed" }
>["prefixComparison"];

function firstPrefixMismatch({ expected, actual }: { expected: number[], actual: number[] }): number | undefined {
  const commonLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (expected[index] !== actual[index]) return index;
  }
  return actual.length < expected.length ? actual.length : undefined;
}

export function classifyContinuityPrefix({
  isEncoderDecoder,
  firstGeneratedSequenceTokenIds,
  secondInputTokenIds,
  secondTurnPastKeyValuesProvided,
}: {
  isEncoderDecoder: boolean,
  firstGeneratedSequenceTokenIds: number[],
  secondInputTokenIds: number[],
  secondTurnPastKeyValuesProvided: boolean,
}): PrefixComparison {
  if (isEncoderDecoder) {
    return {
      mode: "not-applicable-encoder-decoder",
      expectedPrefixTokenIds: [],
      secondInputTokenIds,
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
    };
  }
  if (secondTurnPastKeyValuesProvided) {
    return {
      mode: "cache-suffix",
      expectedPrefixTokenIds: [],
      secondInputTokenIds,
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
    };
  }
  const mismatchIndex = firstPrefixMismatch({
    expected: firstGeneratedSequenceTokenIds,
    actual: secondInputTokenIds,
  });
  return {
    mode: "full-input-prefix",
    expectedPrefixTokenIds: firstGeneratedSequenceTokenIds,
    secondInputTokenIds,
    exactPrefixMatch: mismatchIndex === undefined,
    firstMismatchIndex: mismatchIndex,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
