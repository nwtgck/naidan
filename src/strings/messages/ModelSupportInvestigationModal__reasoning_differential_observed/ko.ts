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
      return "입력 토큰이 동일함";
    case "mismatched":
      return `첫 불일치 위치: ${firstMismatchIndex ?? "길이 경계"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Production 추론 강도 차이 (${strategy}): none=${disabledTokenCount}개 입력 토큰; high=${enabledTokenCount}; ${comparison}; 출력 품질은 평가하지 않음`;
};
