import type {
  ModelSupportInvestigationToolTemplateProvenance,
} from "@/features/transformers-js/model-support-investigation/types";

export type ModelSupportInvestigationToolProtocolProbePlan =
  | {
    status: "eligible",
    inputTokenIds: number[],
    forcedTokenIds: number[],
  }
  | {
    status: "unavailable",
    reason: string,
  };

function validTokenIds({ values }: { values: number[] }): boolean {
  return values.every(value => Number.isSafeInteger(value) && value >= 0);
}

export function planToolProtocolProbe({
  provenance,
  isEncoderDecoder,
  maximumForcedTokenCount,
}: {
  provenance: ModelSupportInvestigationToolTemplateProvenance | undefined,
  isEncoderDecoder: boolean | undefined,
  maximumForcedTokenCount: number,
}): ModelSupportInvestigationToolProtocolProbePlan {
  if (provenance === undefined) {
    return { status: "unavailable", reason: "Tool template provenance was not collected" };
  }
  switch (provenance.status) {
  case "unavailable":
    return { status: "unavailable", reason: provenance.reason };
  case "observed":
    break;
  default: {
    const _ex: never = provenance;
    return _ex;
  }
  }
  if (isEncoderDecoder === true) {
    return { status: "unavailable", reason: "The forced tool protocol probe currently requires a decoder-only model" };
  }
  if (!provenance.generationPromptPrefixMatch) {
    return {
      status: "unavailable",
      reason: "The assistant tool-call history is not an exact extension of the tools-generation prompt",
    };
  }
  const forcedTokenIds = provenance.assistantToolCallSuffixTokenIds;
  if (forcedTokenIds === undefined || forcedTokenIds.length === 0) {
    return { status: "unavailable", reason: "The assistant tool-call history did not produce a non-empty model-output suffix" };
  }
  if (!Number.isSafeInteger(maximumForcedTokenCount) || maximumForcedTokenCount < 1) {
    throw new RangeError(`Maximum forced token count must be a positive safe integer: ${maximumForcedTokenCount}`);
  }
  if (forcedTokenIds.length > maximumForcedTokenCount) {
    return {
      status: "unavailable",
      reason: `The template-derived assistant tool-call suffix has ${forcedTokenIds.length} tokens, exceeding the limit ${maximumForcedTokenCount}`,
    };
  }
  if (!validTokenIds({ values: provenance.generationInputIds }) || !validTokenIds({ values: forcedTokenIds })) {
    return { status: "unavailable", reason: "The template-derived tool protocol contains invalid token IDs" };
  }
  return {
    status: "eligible",
    inputTokenIds: [...provenance.generationInputIds],
    forcedTokenIds: [...forcedTokenIds],
  };
}

export function compareForcedTokenSequence({ expected, actual }: {
  expected: number[],
  actual: number[],
}): {
  exactMatch: boolean,
  firstMismatchIndex: number | undefined,
} {
  const commonLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (expected[index] !== actual[index]) {
      return { exactMatch: false, firstMismatchIndex: index };
    }
  }
  if (expected.length !== actual.length) {
    return { exactMatch: false, firstMismatchIndex: commonLength };
  }
  return { exactMatch: true, firstMismatchIndex: undefined };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
