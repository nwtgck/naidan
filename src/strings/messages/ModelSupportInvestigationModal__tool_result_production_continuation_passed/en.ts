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
      return "exact template match";
    case "mismatched":
      return `first mismatch at ${firstMismatchIndex ?? "boundary"}`;
    default: {
      const _ex: never = inputMatch;
      throw new Error(`Unhandled input match: ${_ex}`);
    }
    }
  })();
  return `Tool-result Production continuation: ${strategy}; generated=${generatedTokenCount} token(s); input=${inputSummary}; tool-loop termination not observed`;
};
