export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `Tool template provenance: ${suffixTokenCount ?? 0} assistant tool-call suffix tokens were isolated from resolved tokenizer output.`;
  case 'difference':
    return `Tool template provenance: the rendered token sequences first differ at ${firstMismatchIndex ?? 'the length boundary'}; no suffix was inferred.`;
  case 'unavailable':
    return `Tool template provenance unavailable: ${reason ?? 'the required template cases were not observed'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
