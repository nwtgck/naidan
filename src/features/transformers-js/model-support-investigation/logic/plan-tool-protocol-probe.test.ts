import { describe, expect, it } from "vitest";
import {
  compareForcedTokenSequence,
  planToolProtocolProbe,
} from "@/features/transformers-js/model-support-investigation/logic/plan-tool-protocol-probe";
import type { ModelSupportInvestigationToolTemplateProvenance } from "@/features/transformers-js/model-support-investigation/types";

const observed: ModelSupportInvestigationToolTemplateProvenance = {
  status: "observed",
  source: "chat-template-render",
  generationCaseId: "tools-generation",
  assistantToolCallCaseId: "assistant-tool-call-history",
  toolResultContinuationCaseId: "tool-result-continuation",
  generationInputIds: [1, 2, 3],
  assistantToolCallInputIds: [1, 2, 3, 4, 5],
  toolResultContinuationInputIds: [1, 2, 3, 4, 5, 6],
  generationPromptPrefixMatch: true,
  firstMismatchIndex: undefined,
  assistantToolCallSuffixTokenIds: [4, 5],
};

describe("planToolProtocolProbe", () => {
  it("plans only the exact template-derived assistant tool-call suffix", () => {
    expect(planToolProtocolProbe({
      provenance: observed,
      isEncoderDecoder: false,
      maximumForcedTokenCount: 256,
    })).toEqual({
      status: "eligible",
      inputTokenIds: [1, 2, 3],
      forcedTokenIds: [4, 5],
    });
  });

  it("does not infer a forced sequence from divergent template inputs", () => {
    expect(planToolProtocolProbe({
      provenance: { ...observed, generationPromptPrefixMatch: false, firstMismatchIndex: 2, assistantToolCallSuffixTokenIds: undefined },
      isEncoderDecoder: false,
      maximumForcedTokenCount: 256,
    })).toEqual({
      status: "unavailable",
      reason: "The assistant tool-call history is not an exact extension of the tools-generation prompt",
    });
  });

  it("does not run on encoder-decoder models", () => {
    expect(planToolProtocolProbe({
      provenance: observed,
      isEncoderDecoder: true,
      maximumForcedTokenCount: 256,
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("decoder-only") });
  });

  it("bounds the generated sequence length", () => {
    expect(planToolProtocolProbe({
      provenance: { ...observed, assistantToolCallSuffixTokenIds: [4, 5, 6] },
      isEncoderDecoder: false,
      maximumForcedTokenCount: 2,
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("exceeding the limit 2") });
  });
});

describe("compareForcedTokenSequence", () => {
  it("distinguishes an exact forced sequence from early termination", () => {
    expect(compareForcedTokenSequence({ expected: [4, 5], actual: [4, 5] })).toEqual({
      exactMatch: true,
      firstMismatchIndex: undefined,
    });
    expect(compareForcedTokenSequence({ expected: [4, 5], actual: [4] })).toEqual({
      exactMatch: false,
      firstMismatchIndex: 1,
    });
  });
});
