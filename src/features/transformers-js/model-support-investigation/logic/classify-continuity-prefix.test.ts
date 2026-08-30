import { describe, expect, it } from "vitest";
import { classifyContinuityPrefix } from "@/features/transformers-js/model-support-investigation/logic/classify-continuity-prefix";

describe("classifyContinuityPrefix", () => {
  it("accepts an exact processed prefix followed by new turn tokens", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 2, 3, 4, 5],
      reconstructedFullInputTokenIds: undefined,
      secondTurnPastKeyValuesProvided: false,
    })).toEqual({
      mode: "full-input-prefix",
      expectedPrefixTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 2, 3, 4, 5],
      reconstructedFullInputTokenIds: undefined,
      comparisonInputSource: "actual-model-input",
      exactPrefixMatch: true,
      firstMismatchIndex: undefined,
      firstMismatchContext: undefined,
    });
  });

  it("records the first actual prefix mismatch", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 9, 3, 4],
      reconstructedFullInputTokenIds: undefined,
      secondTurnPastKeyValuesProvided: false,
    })).toMatchObject({
      mode: "full-input-prefix",
      exactPrefixMatch: false,
      firstMismatchIndex: 1,
    });
  });

  it("does not infer full-prefix equality when KV cache is provided", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: undefined,
      secondTurnPastKeyValuesProvided: true,
    })).toEqual({
      mode: "cache-suffix",
      expectedPrefixTokenIds: [],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: undefined,
      comparisonInputSource: "actual-model-input",
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
      firstMismatchContext: undefined,
    });
  });


  it("compares the reconstructed full conversation even when KV cache is provided", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: [1, 2, 3, 4],
      secondTurnPastKeyValuesProvided: true,
    })).toMatchObject({
      mode: "full-input-prefix",
      comparisonInputSource: "reconstructed-full-conversation",
      exactPrefixMatch: true,
      firstMismatchIndex: undefined,
      expectedPrefixTokenIds: [1, 2, 3],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: [1, 2, 3, 4],
    });
  });

  it("does not apply decoder-only prefix semantics to encoder-decoder models", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: true,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: undefined,
      secondTurnPastKeyValuesProvided: false,
    })).toEqual({
      mode: "not-applicable-encoder-decoder",
      expectedPrefixTokenIds: [],
      secondInputTokenIds: [8, 9],
      reconstructedFullInputTokenIds: undefined,
      comparisonInputSource: "not-applicable",
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
      firstMismatchContext: undefined,
    });
  });
});
