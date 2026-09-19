export const ModelSupportInvestigationModal__tool_result_production_continuation_passed = ({
  strategy,
  generatedTokenCount,
  comparisonInputSource,
  inputMatch,
  firstMismatchIndex,
  cacheDecisionStatus,
  cacheDecisionReason,
  cacheProvided,
}: {
  strategy: string,
  generatedTokenCount: number,
  comparisonInputSource: string,
  inputMatch: "matched" | "mismatched",
  firstMismatchIndex: number | undefined,
  cacheDecisionStatus: string,
  cacheDecisionReason: string,
  cacheProvided: boolean,
}): string => {
  const inputSummary = (() => {
    switch (inputMatch) {
    case "matched":
      return "与模板完全一致";
    case "mismatched":
      return `首次不匹配位置 ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `工具结果 Production 续接: ${strategy}; 已生成=${generatedTokenCount} 个 token; 输入=${inputSummary}; 比较=${comparisonInputSource}; 缓存=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "已提供" : "未提供"}; 未观测到工具循环终止和实际跨轮工具 KV 复用`;
};
