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
      return "correspondência exata com o template";
    case "mismatched":
      return `primeira divergência em ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `continuação de Production após resultado da ferramenta: ${strategy}; gerados=${generatedTokenCount} token(s); entrada=${inputSummary}; comparação=${comparisonInputSource}; cache=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "fornecido" : "não fornecido"}; término do loop de ferramentas e reutilização KV real entre turnos não observados`;
};
