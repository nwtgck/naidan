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
      return "identische Eingabe-Tokens";
    case "mismatched":
      return `erste Abweichung bei ${firstMismatchIndex ?? "Längengrenze"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Differenz der Production-Reasoning-Intensität (${strategy}): none=${disabledTokenCount} ${disabledTokenCount === 1 ? 'Eingabe-Token' : 'Eingabe-Tokens'}; high=${enabledTokenCount}; ${comparison}; die Ausgabequalität wurde nicht bewertet`;
};
