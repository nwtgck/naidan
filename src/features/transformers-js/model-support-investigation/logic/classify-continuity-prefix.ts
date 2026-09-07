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
  reconstructedFullInputTokenIds,
  secondTurnPastKeyValuesProvided,
}: {
  isEncoderDecoder: boolean,
  firstGeneratedSequenceTokenIds: number[],
  secondInputTokenIds: number[],
  reconstructedFullInputTokenIds: number[] | undefined,
  secondTurnPastKeyValuesProvided: boolean,
}): PrefixComparison {
  if (isEncoderDecoder) {
    return {
      mode: "not-applicable-encoder-decoder",
      expectedPrefixTokenIds: [],
      secondInputTokenIds,
      reconstructedFullInputTokenIds,
      comparisonInputSource: "not-applicable",
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
      firstMismatchContext: undefined,
    };
  }

  const comparisonInputTokenIds = reconstructedFullInputTokenIds ?? (
    secondTurnPastKeyValuesProvided ? undefined : secondInputTokenIds
  );
  if (comparisonInputTokenIds === undefined) {
    return {
      mode: "cache-suffix",
      expectedPrefixTokenIds: [],
      secondInputTokenIds,
      reconstructedFullInputTokenIds: undefined,
      comparisonInputSource: "actual-model-input",
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
      firstMismatchContext: undefined,
    };
  }

  const mismatchIndex = firstPrefixMismatch({
    expected: firstGeneratedSequenceTokenIds,
    actual: comparisonInputTokenIds,
  });
  return {
    mode: "full-input-prefix",
    expectedPrefixTokenIds: firstGeneratedSequenceTokenIds,
    secondInputTokenIds,
    reconstructedFullInputTokenIds,
    comparisonInputSource: reconstructedFullInputTokenIds === undefined
      ? "actual-model-input"
      : "reconstructed-full-conversation",
    exactPrefixMatch: mismatchIndex === undefined,
    firstMismatchIndex: mismatchIndex,
    firstMismatchContext: undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
