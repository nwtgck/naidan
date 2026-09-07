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
      return "coincidencia exacta con la plantilla";
    case "mismatched":
      return `primera diferencia en ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `continuación de Production tras resultado de herramienta: ${strategy}; generados=${generatedTokenCount} token(s); entrada=${inputSummary}; comparación=${comparisonInputSource}; caché=${cacheDecisionStatus} (${cacheDecisionReason}); past_key_values=${cacheProvided ? "proporcionado" : "no proporcionado"}; terminación del bucle de herramientas y reutilización KV real entre turnos no observadas`;
};
