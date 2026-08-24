import { describe, expect, it } from "vitest";
import { classifyContinuityPrefix } from "@/features/transformers-js/model-support-investigation/logic/classify-continuity-prefix";

describe("classifyContinuityPrefix", () => {
  it("accepts an exact processed prefix followed by new turn tokens", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 2, 3, 4, 5],
      secondTurnPastKeyValuesProvided: false,
    })).toEqual({
      mode: "full-input-prefix",
      expectedPrefixTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 2, 3, 4, 5],
      exactPrefixMatch: true,
      firstMismatchIndex: undefined,
    });
  });

  it("records the first actual prefix mismatch", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: false,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [1, 9, 3, 4],
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
      secondTurnPastKeyValuesProvided: true,
    })).toEqual({
      mode: "cache-suffix",
      expectedPrefixTokenIds: [],
      secondInputTokenIds: [8, 9],
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
    });
  });

  it("does not apply decoder-only prefix semantics to encoder-decoder models", () => {
    expect(classifyContinuityPrefix({
      isEncoderDecoder: true,
      firstGeneratedSequenceTokenIds: [1, 2, 3],
      secondInputTokenIds: [8, 9],
      secondTurnPastKeyValuesProvided: false,
    })).toEqual({
      mode: "not-applicable-encoder-decoder",
      expectedPrefixTokenIds: [],
      secondInputTokenIds: [8, 9],
      exactPrefixMatch: undefined,
      firstMismatchIndex: undefined,
    });
  });
});
