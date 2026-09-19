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
      return "exact template match";
    case "mismatched":
      return `first mismatch at ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Tool-result Production continuation: ${strategy}; generated=${generatedTokenCount} token(s); input=${inputSummary}; comparison=${comparisonInputSource}; cache=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "provided" : "not provided"}; tool-loop termination and actual cross-turn tool KV reuse not observed`;
};
