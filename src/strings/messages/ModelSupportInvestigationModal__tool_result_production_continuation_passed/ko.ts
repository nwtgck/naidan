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
      return "템플릿과 완전 일치";
    case "mismatched":
      return `첫 불일치 위치 ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `도구 결과 Production 연속 실행: ${strategy}; 생성=${generatedTokenCount} 토큰; 입력=${inputSummary}; 비교=${comparisonInputSource}; 캐시=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "제공됨" : "제공되지 않음"}; tool-loop 종료 및 실제 cross-turn tool KV 재사용은 관측되지 않음`;
};
