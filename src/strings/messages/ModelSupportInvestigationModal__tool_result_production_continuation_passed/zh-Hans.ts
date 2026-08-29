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
      return "与模板完全匹配";
    case "mismatched":
      return `首次不一致位于 ${firstMismatchIndex ?? "边界"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `工具结果后的 Production 续生成：${strategy}；生成=${generatedTokenCount} 个 token；输入=${inputSummary}；未观测到工具循环终止`;
};
