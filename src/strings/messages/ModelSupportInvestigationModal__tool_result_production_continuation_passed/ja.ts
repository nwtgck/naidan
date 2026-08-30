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
      return "templateと完全一致";
    case "mismatched":
      return `最初の不一致 ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `tool-result Production continuation: ${strategy}; 生成=${generatedTokenCount} tokens; 入力=${inputSummary}; 比較元=${comparisonInputSource}; cache=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "あり" : "なし"}; tool-loop終了と実際のcross-turn tool KV再利用は未観測`;
};
