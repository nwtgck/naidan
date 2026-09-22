export const ModelSupportInvestigationSession__feature_check_result = ({ kind, outcome, context }: { kind: 'first-turn' | 'continuity' | 'tool-result' | 'reasoning' | 'multimodal' | 'template' | 'reference-load' | 'input-strategy' | 'natural-generation' | 'tool-probe' | 'tool-parser' | 'tool-template' | 'stage'; outcome: 'passed' | 'failed' | 'observed' | 'blocked' | 'not-run' | 'not-selected' | 'not-recorded' | 'unavailable'; context: string }): string => {
  const features = {
    "first-turn": "首轮生成",
    "continuity": "对话连续性",
    "tool-result": "工具结果后的续接",
    "reasoning": "推理",
    "multimodal": "图像输入",
    "template": "聊天模板",
    "reference-load": "Reference 加载",
    "input-strategy": "输入方式",
    "natural-generation": "自然生成",
    "tool-probe": "强制工具格式",
    "tool-parser": "工具解析器",
    "tool-template": "工具结果模板",
    "stage": "调查阶段"
  };
  const outcomes = {
    "passed": "执行成功",
    "failed": "失败",
    "observed": "仅观测",
    "blocked": "受阻",
    "not-run": "未执行",
    "not-selected": "未选择",
    "not-recorded": "未记录",
    "unavailable": "不可用"
  };
  return `${features[kind]} · ${outcomes[outcome]} (${context})`;
};
