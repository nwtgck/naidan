export const ModelSupportInvestigationModal__tool_result_production_continuation_passed = ({
  strategy,
  generatedTokenCount,
  inputMatch,
  firstMismatchIndex,
}: {
  strategy: string,
  generatedTokenCount: number,
  inputMatch: "matched" | "mismatched",
  firstMismatchIndex: number | undefined,
}): string => {
  const inputSummary = (() => {
    switch (inputMatch) {
    case "matched":
      return "templateと完全一致";
    case "mismatched":
      return `${firstMismatchIndex ?? "境界"}で最初の不一致`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `tool result後のProduction継続: ${strategy}; 生成=${generatedTokenCount} token; 入力=${inputSummary}; tool loop終了は未観測`;
};
