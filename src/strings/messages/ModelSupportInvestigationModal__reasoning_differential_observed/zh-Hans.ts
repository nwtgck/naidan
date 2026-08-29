export const ModelSupportInvestigationModal__reasoning_differential_observed = ({
  strategy,
  disabledTokenCount,
  enabledTokenCount,
  inputMatch,
  firstMismatchIndex,
}: {
  strategy: string,
  disabledTokenCount: number,
  enabledTokenCount: number,
  inputMatch: "matched" | "mismatched",
  firstMismatchIndex: number | undefined,
}): string => {
  const comparison = (() => {
    switch (inputMatch) {
    case "matched":
      return "输入 token 完全一致";
    case "mismatched":
      return `首次不一致位于 ${firstMismatchIndex ?? "长度边界"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Production 推理强度差异（${strategy}）：none=${disabledTokenCount} 个输入 token；high=${enabledTokenCount}; ${comparison}；未评估输出质量`;
};
