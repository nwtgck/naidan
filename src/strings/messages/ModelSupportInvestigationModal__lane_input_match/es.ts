export const ModelSupportInvestigationModal__lane_input_match = ({ tokenCount }: { tokenCount: number }): string => tokenCount === 1
  ? 'El token de entrada de Reference y Production coincide exactamente (1 token)'
  : `Los tokens de entrada de Reference y Production coinciden exactamente (${tokenCount} tokens)`;
