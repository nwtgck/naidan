export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `ツールテンプレート由来：resolved tokenizerの出力からassistant tool call suffix ${suffixTokenCount ?? 0} tokenを分離しました。`;
  case 'difference':
    return `ツールテンプレート由来：rendered token列は${firstMismatchIndex ?? '長さ境界'}で最初に異なり、suffixは推定していません。`;
  case 'unavailable':
    return `ツールテンプレート由来を取得できません：${reason ?? '必要なtemplate caseが観測されませんでした'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
