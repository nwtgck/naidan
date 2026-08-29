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
      return "템플릿과 정확히 일치";
    case "mismatched":
      return `첫 불일치 위치: ${firstMismatchIndex ?? "경계"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `도구 결과 이후 Production 연속 생성: ${strategy}; 생성=${generatedTokenCount} 토큰; 입력=${inputSummary}; 도구 루프 종료는 관측되지 않음`;
};
