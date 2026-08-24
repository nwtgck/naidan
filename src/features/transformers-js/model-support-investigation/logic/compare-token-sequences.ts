export interface ModelSupportInvestigationTokenSequenceComparison {
  exactMatch: boolean,
  firstMismatchIndex: number | undefined,
}

export function compareTokenSequences({ expected, actual }: {
  expected: number[],
  actual: number[],
}): ModelSupportInvestigationTokenSequenceComparison {
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

export const TEST_ONLY = {
};
