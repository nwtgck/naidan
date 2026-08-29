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
      return "correspondência exata com o template";
    case "mismatched":
      return `primeira divergência em ${firstMismatchIndex ?? "limite"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Continuação de Production após o resultado da ferramenta: ${strategy}; gerados=${generatedTokenCount} ${generatedTokenCount === 1 ? 'token' : 'tokens'}; entrada=${inputSummary}; término do loop de ferramentas não observado`;
};
