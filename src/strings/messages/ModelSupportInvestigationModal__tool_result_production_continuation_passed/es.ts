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
      return "coincidencia exacta con la plantilla";
    case "mismatched":
      return `primera divergencia en ${firstMismatchIndex ?? "límite"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Continuación de Production tras el resultado de la herramienta: ${strategy}; generados=${generatedTokenCount} ${generatedTokenCount === 1 ? 'token' : 'tokens'}; entrada=${inputSummary}; no se observó la terminación del bucle de herramientas`;
};
