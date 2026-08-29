export const ModelSupportInvestigationModal__lane_input_match = ({ tokenCount }: { tokenCount: number }): string => tokenCount === 1
  ? 'Das Reference- und Production-Eingabetoken stimmt exakt überein (1 Token)'
  : `Die Reference- und Production-Eingabetokens stimmen exakt überein (${tokenCount} Tokens)`;
