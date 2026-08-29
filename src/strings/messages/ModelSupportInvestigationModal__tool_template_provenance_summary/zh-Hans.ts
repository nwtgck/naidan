export const ModelSupportInvestigationModal__tool_template_provenance_summary = ({ mode, suffixTokenCount, firstMismatchIndex, reason }: { mode: 'prefix' | 'difference' | 'unavailable'; suffixTokenCount: number | undefined; firstMismatchIndex: number | undefined; reason: string | undefined }): string => {
  switch (mode) {
  case 'prefix':
    return `工具模板来源：已从解析后的分词器输出中分离出 ${suffixTokenCount ?? 0} 个 assistant 工具调用后缀 token。`;
  case 'difference':
    return `工具模板来源：渲染后的 token 序列首次在 ${firstMismatchIndex ?? '长度边界'} 处不同；未推断出后缀。`;
  case 'unavailable':
    return `无法获取工具模板来源：${reason ?? '未观测到所需的模板用例'}`;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
};
