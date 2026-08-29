export const ModelSupportInvestigationModal__lane_input_match = ({ tokenCount }: { tokenCount: number }): string => tokenCount === 1
  ? 'O token de entrada de Reference e Production corresponde exatamente (1 token)'
  : `Os tokens de entrada de Reference e Production correspondem exatamente (${tokenCount} tokens)`;
