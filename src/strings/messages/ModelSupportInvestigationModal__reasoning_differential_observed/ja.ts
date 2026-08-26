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
      return "入力token列は同一";
    case "mismatched":
      return `${firstMismatchIndex ?? "長さ境界"}で最初の不一致`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Production reasoning effort差分 (${strategy}): none=${disabledTokenCount} input token; high=${enabledTokenCount}; ${comparison}; 出力品質は評価していません`;
};
