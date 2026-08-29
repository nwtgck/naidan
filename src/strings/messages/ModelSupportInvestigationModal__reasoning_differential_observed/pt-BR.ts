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
      return "tokens de entrada idênticos";
    case "mismatched":
      return `primeira divergência em ${firstMismatchIndex ?? "limite de comprimento"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Diferencial de esforço de raciocínio de Production (${strategy}): none=${disabledTokenCount} ${disabledTokenCount === 1 ? 'token de entrada' : 'tokens de entrada'}; high=${enabledTokenCount}; ${comparison}; a qualidade da saída não foi avaliada`;
};
