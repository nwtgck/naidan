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
      return "exakte Template-Übereinstimmung";
    case "mismatched":
      return `erste Abweichung bei ${firstMismatchIndex ?? "Grenze"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Production-Fortsetzung nach dem Tool-Ergebnis: ${strategy}; generiert=${generatedTokenCount} ${generatedTokenCount === 1 ? 'Token' : 'Tokens'}; Eingabe=${inputSummary}; Beendigung der Tool-Schleife nicht beobachtet`;
};
