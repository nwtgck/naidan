export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `Herkunft des Tool-Templates: ${suffixTokenCount ?? 0} ${(suffixTokenCount ?? 0) === 1 ? 'Suffix-Token' : 'Suffix-Tokens'} des Assistant-Tool-Aufrufs ${(suffixTokenCount ?? 0) === 1 ? 'wurde' : 'wurden'} aus der aufgelösten Tokenizer-Ausgabe isoliert.`;
  case 'difference':
    return `Herkunft des Tool-Templates: die gerenderten Token-Sequenzen unterscheiden sich erstmals bei ${firstMismatchIndex ?? 'der Längengrenze'}; es wurde kein Suffix abgeleitet.`;
  case 'unavailable':
    return `Herkunft des Tool-Templates nicht verfügbar: ${reason ?? 'die erforderlichen Template-Fälle wurden nicht beobachtet'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
