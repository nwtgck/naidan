import { describe, expect, it } from "vitest";
import { compareTokenSequences } from "@/features/transformers-js/model-support-investigation/logic/compare-token-sequences";

describe("compareTokenSequences", () => {
  it("records exact equality", () => {
    expect(compareTokenSequences({ expected: [1, 2], actual: [1, 2] })).toEqual({
      exactMatch: true,
      firstMismatchIndex: undefined,
    });
  });

  it("records the first differing token", () => {
    expect(compareTokenSequences({ expected: [1, 2, 3], actual: [1, 9, 3] })).toEqual({
      exactMatch: false,
      firstMismatchIndex: 1,
    });
  });

  it("records the shorter-sequence boundary", () => {
    expect(compareTokenSequences({ expected: [1, 2, 3], actual: [1, 2] })).toEqual({
      exactMatch: false,
      firstMismatchIndex: 2,
    });
  });
});
